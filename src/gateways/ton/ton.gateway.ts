import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { TonClient, TonCredenciais } from './ton.client';
import { PaymentGateway } from '../core/payment-gateway.interface';
import { GatewayResourceNotFoundError } from '../core/gateway.errors';
import { aplicarDesconto, totalEmCentavos } from '../core/discount';
import {
  GatewayCharge,
  GatewayContext,
  GatewayHealth,
  GatewayWebhookEvent,
  HostedCheckoutRequest,
  HostedCheckoutResult,
  PaymentGatewayDescriptor,
  WebhookRequest,
} from '../core/gateway.types';
import { cabecalho } from '../pagbank/pagbank.gateway';

/** O checkout do Pagar.me mede a validade em minutos */
const MINUTO = 60 * 1000;

/**
 * Ton (Stone).
 *
 * A Ton não publica API própria de link de pagamento — o link nasce no app. O
 * que a conta Ton/Stone habilita é a API do grupo, o Pagar.me v5, e é sobre o
 * checkout hospedado dela que esta integração roda: um pedido com
 * `payment_method: "checkout"` devolve uma `payment_url`, que é exatamente o
 * mesmo contrato das outras três.
 *
 * A base é configurável na credencial para o caso de a Stone apontar a conta
 * para um endereço próprio — é a única parte da integração que pode mudar sem
 * o resto mudar junto.
 */
@Injectable()
export class TonGateway implements PaymentGateway {
  private readonly logger = new Logger(TonGateway.name);

  constructor(private readonly client: TonClient) {}

  readonly descriptor: PaymentGatewayDescriptor = {
    provider: PaymentProvider.TON,
    label: 'Ton (Stone)',
    summary:
      'Checkout hospedado da Stone/Pagar.me, com Pix, boleto e cartão de crédito.',
    paymentMethods: [
      PaymentMethod.PIX,
      PaymentMethod.BOLETO,
      PaymentMethod.CREDIT_CARD,
    ],
    fields: [
      {
        key: 'secretKey',
        label: 'Chave secreta',
        required: true,
        secret: true,
        placeholder: 'sk_… (produção) ou sk_test_… (sandbox)',
        help: 'Painel da Stone/Pagar.me › Configurações › Chaves. Use a chave secreta, nunca a pública.',
      },
      {
        key: 'webhookSecret',
        label: 'Assinatura do webhook (recomendado)',
        required: false,
        secret: true,
        help: 'Configurada junto da URL de notificação no painel. Sem ela, o sistema confere cada aviso consultando o pedido na API.',
      },
      {
        key: 'maxInstallments',
        label: 'Parcelas no cartão',
        required: false,
        secret: false,
        placeholder: '1',
        help: 'Quantas parcelas sem juros oferecer. Acima de 1, a taxa das parcelas fica com a igreja.',
      },
      {
        key: 'baseUrl',
        label: 'URL da API (opcional)',
        required: false,
        secret: false,
        allowedHostSuffixes: ['pagar.me', 'stone.com.br', 'ton.com.br'],
        help: 'Deixe em branco para usar o endereço oficial do ambiente escolhido.',
      },
    ],
    docsUrl: 'https://docs.pagar.me/reference/criar-pedido',
    signsWebhook: true,
    webhookChannels: [{ key: 'payments', label: 'Notificação de pedido' }],
  };

  async createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    const cred = this.cred(ctx);
    const itens = aplicarDesconto(pedido.items, pedido.discountCents);
    const total = totalEmCentavos(itens);

    const minutos = Math.max(
      5,
      Math.round((pedido.expiresAt.getTime() - Date.now()) / MINUTO),
    );

    const payload = {
      code: pedido.referenceId,
      closed: false,
      customer: {
        name: pedido.customer.name,
        email: pedido.customer.email,
        type: 'individual',
        document: pedido.customer.taxId.replace(/\D/g, ''),
        document_type: 'CPF',
        phones: {
          mobile_phone: {
            country_code: pedido.customer.phone.country,
            area_code: pedido.customer.phone.area,
            number: pedido.customer.phone.number,
          },
        },
      },
      items: itens.map((item) => ({
        code: item.referenceId,
        description: item.description || item.name,
        quantity: item.quantity,
        amount: item.unitAmountCents,
      })),
      payments: [
        {
          payment_method: 'checkout',
          checkout: {
            expires_in: minutos,
            default_payment_method: 'pix',
            accepted_payment_methods: ['credit_card', 'pix', 'boleto'],
            success_url: pedido.redirectUrl,
            customer_editable: false,
            skip_checkout_success_page: false,
            credit_card: {
              statement_descriptor: pedido.softDescriptor.slice(0, 13),
              // Sem juros e com o total igual ao valor da compra: quem escolhe
              // parcelar não paga a mais, e a taxa fica com a igreja — daí o
              // padrão ser 1 e a escolha ser explícita na configuração.
              installments: this.parcelas(cred, total),
            },
            pix: { expires_in: minutos * 60 },
          },
        },
      ],
    };

    const pedidoCriado = await this.client.createOrder(payload, cred, ctx.mode);

    const checkout = pedidoCriado?.checkouts?.[0];

    return {
      // O id do pedido, e não o do checkout: é ele que a API aceita para
      // cancelar, e cancelar é a única coisa que fazemos com esse id depois.
      checkoutId: pedidoCriado?.id,
      payUrl: checkout?.payment_url ?? '',
      raw: pedidoCriado,
    };
  }

  async listCharges(
    referenceId: string,
    ctx: GatewayContext,
  ): Promise<GatewayCharge[]> {
    const pedidos = await this.client.findOrdersByCode(
      referenceId,
      this.cred(ctx),
      ctx.mode,
    );

    const charges = pedidos.flatMap((pedido: any) => pedido?.charges ?? []);

    if (charges.length === 0) {
      throw new GatewayResourceNotFoundError('Ton', referenceId);
    }

    return charges.map((charge: any) => this.paraCharge(charge));
  }

  async inactivateCheckout(checkoutId: string, ctx: GatewayContext) {
    await this.client.cancelOrder(checkoutId, this.cred(ctx), ctx.mode);
  }

  /**
   * `X-Hub-Signature-256: sha256=<hmac>` sobre o corpo cru.
   *
   * Quando a conta não tem assinatura configurada, a conferência aqui passa e
   * a garantia se desloca para `parseWebhook`, que vai buscar o pedido na API
   * com a chave da igreja. É por isso que o campo é "recomendado" e não
   * "obrigatório": sem ele a integração continua correta, só mais cara em
   * chamadas.
   */
  verifyWebhook(req: WebhookRequest, ctx: GatewayContext): boolean {
    const segredo = this.cred(ctx).webhookSecret?.trim();
    if (!segredo) return true;

    const recebido = (
      cabecalho(req, 'x-hub-signature-256') || cabecalho(req, 'x-hub-signature')
    ).replace(/^sha256=/i, '');

    if (!recebido) {
      this.logger.warn(
        'Ton — notificação sem assinatura, mas a igreja cadastrou um segredo. Recusada.',
      );
      return false;
    }

    const esperado = createHmac('sha256', segredo)
      .update(req.rawBody)
      .digest('hex');

    const a = Buffer.from(recebido.toLowerCase(), 'utf8');
    const b = Buffer.from(esperado, 'utf8');

    return a.length === b.length && timingSafeEqual(a as any, b as any);
  }

  async parseWebhook(
    req: WebhookRequest,
    ctx: GatewayContext,
  ): Promise<GatewayWebhookEvent> {
    const tipo: string = req.body?.type ?? '';
    const dados = req.body?.data ?? {};

    // Chegam avisos de recebedor, assinatura e antecipação na mesma URL
    if (!tipo.startsWith('order.') && !tipo.startsWith('charge.')) {
      return { kind: 'ignored', reason: `notificação do tipo ${tipo}` };
    }

    const code: string | undefined = dados.code ?? dados.order?.code;
    const orderId: string | undefined = dados.order?.id ?? dados.id;

    if (!code && !orderId) {
      return {
        kind: 'ignored',
        reason: 'notificação sem pedido identificável',
      };
    }

    // O corpo aponta o pedido; o estado vem da API, com a chave da igreja.
    // Vale mesmo com assinatura conferida: um replay de uma notificação antiga
    // e legítima carrega um status que já não é o atual.
    const pedido = orderId
      ? await this.client.getOrder(orderId, this.cred(ctx), ctx.mode)
      : (
          await this.client.findOrdersByCode(code!, this.cred(ctx), ctx.mode)
        )[0];

    if (!pedido) {
      return { kind: 'ignored', reason: 'pedido não encontrado na Ton' };
    }

    const referenceId = pedido.code ?? code;
    if (!referenceId) {
      return { kind: 'ignored', reason: 'pedido sem referência deste sistema' };
    }

    const charges: any[] = pedido.charges ?? [];
    const paga = charges.find((c) => c.status === 'paid');
    const escolhida =
      paga ??
      [...charges].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )[0];

    if (!escolhida) {
      return { kind: 'ignored', reason: 'pedido ainda sem cobrança' };
    }

    const charge = this.paraCharge(escolhida);

    return {
      kind: 'payment',
      referenceId,
      status: charge.status,
      method: charge.method,
      paidAmountCents: charge.paidAmountCents,
      payload: {
        payment_method: { type: escolhida.payment_method },
        codeTransaction: escolhida.id,
        receipt:
          escolhida.last_transaction?.pdf ??
          escolhida.last_transaction?.url ??
          null,
      },
    };
  }

  async healthCheck(ctx: GatewayContext): Promise<GatewayHealth> {
    const cred = this.cred(ctx);
    const chave = cred.secretKey?.trim() ?? '';

    if (chave.startsWith('pk_')) {
      return {
        ok: false,
        message:
          'Esta é a chave pública (pk_…). A integração precisa da chave secreta (sk_…).',
      };
    }

    const ehTeste = chave.startsWith('sk_test_');
    const esperaTeste = ctx.mode === PaymentProviderMode.SANDBOX;

    if (chave.startsWith('sk_') && ehTeste !== esperaTeste) {
      return {
        ok: false,
        message: esperaTeste
          ? 'Esta é uma chave de produção, mas o ambiente selecionado é sandbox.'
          : 'Esta é uma chave de teste, mas o ambiente selecionado é produção.',
      };
    }

    try {
      await this.client.ping(cred, ctx.mode);
      return { ok: true, message: 'Chave aceita pela Ton/Stone.' };
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      this.logger.warn(`Ton — teste de credencial falhou: ${status}`);

      return {
        ok: false,
        message:
          status === 401 || status === 403
            ? 'A Ton recusou esta chave secreta.'
            : 'Não foi possível falar com a Ton agora.',
      };
    }
  }

  /**
   * As parcelas oferecidas, todas com o total igual ao valor da compra.
   *
   * O teto vem da configuração da igreja e é limitado a 12 — acima disso o
   * Pagar.me recusa o pedido inteiro, e um `12` digitado como `120` derrubaria
   * todo checkout daquela igreja sem dizer por quê.
   */
  private parcelas(cred: TonCredenciais, total: number) {
    const pedido = Number(cred.maxInstallments);
    const teto =
      Number.isInteger(pedido) && pedido > 0 ? Math.min(pedido, 12) : 1;

    return Array.from({ length: teto }, (_, i) => ({
      number: i + 1,
      total,
    }));
  }

  private paraCharge(charge: any): GatewayCharge {
    // `paid_amount` é o que entrou; `amount` é o que foi pedido. A conferência
    // quer o primeiro — em cobrança paga a menor os dois diferem, e é
    // exatamente esse caso que ela existe para pegar.
    const pago = charge?.paid_amount ?? charge?.amount;

    return {
      status: mapearStatus(charge.status),
      method: mapearMetodo(charge.payment_method),
      createdAt: new Date(charge.created_at ?? Date.now()),
      paidAmountCents: typeof pago === 'number' ? pago : null,
      raw: charge,
    };
  }

  private cred(ctx: GatewayContext): TonCredenciais {
    return {
      secretKey: ctx.credentials.secretKey,
      webhookSecret: ctx.credentials.webhookSecret,
      maxInstallments: ctx.credentials.maxInstallments,
      baseUrl: ctx.credentials.baseUrl,
    };
  }
}

function mapearMetodo(metodo?: string): PaymentMethod {
  switch (metodo) {
    case 'pix':
      return PaymentMethod.PIX;
    case 'credit_card':
      return PaymentMethod.CREDIT_CARD;
    case 'debit_card':
      return PaymentMethod.DEBIT_CARD;
    case 'boleto':
      return PaymentMethod.BOLETO;
    default:
      return PaymentMethod.OTHER;
  }
}

function mapearStatus(status?: string): PaymentStatus {
  switch (status) {
    case 'paid':
    // Pago a mais é pago: a diferença é um acerto de caixa, não uma pendência
    // que deva manter a inscrição travada.
    case 'overpaid':
      return PaymentStatus.PAID;
    case 'processing':
    case 'underpaid':
      return PaymentStatus.IN_ANALYSIS;
    case 'failed':
    case 'payment_failed':
    case 'not_authorized':
      return PaymentStatus.DECLINED;
    case 'canceled':
      return PaymentStatus.CANCELED;
    case 'refunded':
    case 'chargedback':
      return PaymentStatus.REFUNDED;
    default:
      return PaymentStatus.WAITING;
  }
}
