import { Injectable } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';
import { PayPalClient, PayPalCredenciais } from './paypal.client';
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

/**
 * PayPal — Orders v2 com redirecionamento.
 *
 * Mesmo contrato dos outros gateways (pedido criado aqui, link, pagamento do
 * lado de lá), com uma diferença que molda o arquivo inteiro: **o comprador
 * aprova, e quem move o dinheiro é o servidor**, chamando a captura. Pedido
 * aprovado e não capturado não é pagamento — e expira em 6 horas.
 *
 * Por isso a captura acontece em todo lugar que olha o pedido (`pedidoAtual`):
 * no webhook de aprovação, na reconciliação de 3 em 3 horas e na conferência
 * que antecede um checkout novo. Os três caem na mesma função, e captura
 * repetida é inofensiva (o PayPal responde 422 e o pedido é relido).
 */
@Injectable()
export class PayPalGateway implements PaymentGateway {
  constructor(private readonly client: PayPalClient) {}

  readonly descriptor: PaymentGatewayDescriptor = {
    provider: PaymentProvider.PAYPAL,
    label: 'PayPal',
    summary:
      'Checkout do PayPal: o inscrito paga com o saldo da conta PayPal ou com cartão de crédito.',
    paymentMethods: [PaymentMethod.CREDIT_CARD],
    fields: [
      {
        key: 'clientId',
        label: 'Client ID',
        required: true,
        // é público por natureza (vai no navegador em toda integração com o
        // SDK do PayPal); mostrar inteiro ajuda a conferir a aplicação certa
        secret: false,
        help: 'developer.paypal.com › Apps & Credentials › sua aplicação. Sandbox e Live têm credenciais diferentes.',
      },
      {
        key: 'clientSecret',
        label: 'Secret',
        required: true,
        secret: true,
        help: 'Na mesma tela do Client ID, em "Secret key".',
      },
    ],
    docsUrl: 'https://developer.paypal.com/docs/api/orders/v2/',
    // O PayPal assina, mas a assinatura não é o que segura a baixa: ver
    // `verifyWebhook`. `true` aqui é o que diz à tela que o segredo da URL não
    // é a única tranca.
    signsWebhook: true,
    webhookChannels: [{ key: 'payments', label: 'Notificação de pagamento' }],
  };

  async createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    // O PayPal tem `breakdown.discount`, mas o total cobrado precisa bater
    // com `chargedAmountCents`, que é calculado por `aplicarDesconto` — usar
    // a mesma conta evita dois números diferentes para a mesma cobrança.
    const itens = aplicarDesconto(pedido.items, pedido.discountCents);
    const total = reais(totalEmCentavos(itens));

    const payload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          // o PayPal devolve os dois no GET do pedido; `reference_id` é por
          // onde a baixa reencontra a cobrança, `custom_id` aparece no
          // relatório de transações da conta, para a tesouraria conferir
          reference_id: pedido.referenceId,
          custom_id: pedido.referenceId,
          description: pedido.eventName.slice(0, 127),
          soft_descriptor: pedido.softDescriptor.slice(0, 22),
          // item_total tem que ser exatamente a soma dos itens, ou o PayPal
          // recusa o pedido inteiro — daí tudo sair dos mesmos centavos
          amount: {
            currency_code: 'BRL',
            value: total,
            breakdown: { item_total: { currency_code: 'BRL', value: total } },
          },
          items: itens.map((item) => ({
            name: item.name.slice(0, 127),
            description: (item.description ?? '').slice(0, 127),
            quantity: String(item.quantity),
            unit_amount: {
              currency_code: 'BRL',
              value: reais(item.unitAmountCents),
            },
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            locale: 'pt-BR',
            shipping_preference: 'NO_SHIPPING',
            // "Pagar agora" em vez de "Continuar": não há tela de revisão
            // nossa depois do PayPal
            user_action: 'PAY_NOW',
            return_url: pedido.redirectUrl,
            cancel_url: pedido.redirectUrl,
          },
        },
      },
    };

    const criado = await this.client.createOrder(
      payload,
      this.cred(ctx),
      ctx.mode,
      pedido.referenceId,
    );

    const link = (criado?.links ?? []).find(
      (l: any) => l.rel === 'payer-action' || l.rel === 'approve',
    );

    return { checkoutId: criado?.id, payUrl: link?.href ?? '', raw: criado };
  }

  async listCharges(
    referenceId: string,
    ctx: GatewayContext,
    checkoutId?: string,
  ): Promise<GatewayCharge[]> {
    const pedido = checkoutId ? await this.pedidoAtual(checkoutId, ctx) : null;

    // Pedido expirado some da API (404). A referência é conferida também: o
    // id veio do nosso banco, mas a baixa é pela referência, e as duas têm
    // que apontar para a mesma cobrança.
    if (!pedido || referenciaDo(pedido) !== referenceId) {
      throw new GatewayResourceNotFoundError('PayPal', referenceId);
    }

    return [this.paraCharge(pedido)];
  }

  /**
   * O Orders v2 não tem como cancelar um pedido ainda não aprovado — ele
   * expira sozinho em 6 horas. Não é falha, e não pode travar o fluxo (ver o
   * contrato). O risco que sobra está em `docs/paypal.md`.
   */
  async inactivateCheckout(): Promise<void> {
    return;
  }

  /**
   * O PayPal assina a notificação com certificado, mas conferir exige o
   * `webhook_id` da aplicação e uma chamada assíncrona — e este método é
   * síncrono. A garantia aqui é a mesma do PagBank: o corpo só aponta o
   * pedido, e `parseWebhook` lê o estado na API com a credencial da igreja.
   * Um POST forjado com a URL certa consegue, no máximo, fazer o sistema
   * conferir um pedido real daquela conta.
   */
  verifyWebhook(): boolean {
    return true;
  }

  async parseWebhook(
    req: WebhookRequest,
    ctx: GatewayContext,
  ): Promise<GatewayWebhookEvent> {
    const tipo: string = req.body?.event_type ?? '';
    const recurso = req.body?.resource ?? {};

    // Aprovação traz o pedido; captura traz a captura, com o pedido ao lado
    const orderId =
      tipo === 'CHECKOUT.ORDER.APPROVED'
        ? recurso.id
        : tipo.startsWith('PAYMENT.CAPTURE.')
        ? recurso.supplementary_data?.related_ids?.order_id
        : undefined;

    if (!orderId) {
      return { kind: 'ignored', reason: `notificação do tipo ${tipo}` };
    }

    const pedido = await this.pedidoAtual(String(orderId), ctx);
    const referenceId = pedido && referenciaDo(pedido);

    if (!referenceId) {
      return {
        kind: 'ignored',
        reason: 'pedido inexistente nesta conta PayPal ou sem referência',
      };
    }

    const charge = this.paraCharge(pedido);

    return {
      kind: 'payment',
      referenceId,
      status: charge.status,
      method: charge.method,
      paidAmountCents: charge.paidAmountCents,
      payload: charge.payload,
    };
  }

  async healthCheck(ctx: GatewayContext): Promise<GatewayHealth> {
    const ambiente =
      ctx.mode === PaymentProviderMode.SANDBOX ? 'sandbox' : 'produção';

    try {
      const token = await this.client.token(this.cred(ctx), ctx.mode);

      return {
        ok: true,
        account: token.app_id,
        message: `Credenciais aceitas pelo PayPal em ${ambiente}.`,
      };
    } catch (err: any) {
      const status = err?.response?.status;

      return {
        ok: false,
        message:
          status === 401 || status === 403
            ? `O PayPal recusou estas credenciais em ${ambiente}. As de sandbox e as de produção são diferentes: confira a aba do painel.`
            : 'Não foi possível falar com o PayPal agora.',
      };
    }
  }

  /**
   * O pedido como ele está agora — capturado, se o comprador já aprovou.
   *
   * Sem a captura, um inscrito que aprovou o pagamento ficaria em "aguardando"
   * até o pedido expirar, e o dinheiro nunca sairia da conta dele.
   */
  private async pedidoAtual(orderId: string, ctx: GatewayContext) {
    const cred = this.cred(ctx);
    const pedido = await this.client.getOrder(orderId, cred, ctx.mode);

    if (pedido?.status !== 'APPROVED') return pedido;

    await this.client.captureOrder(orderId, cred, ctx.mode);
    return this.client.getOrder(orderId, cred, ctx.mode);
  }

  private paraCharge(pedido: any): GatewayCharge {
    const capturas: any[] =
      pedido.purchase_units?.[0]?.payments?.captures ?? [];
    const captura = capturas[capturas.length - 1];
    const fonte = Object.keys(pedido.payment_source ?? {})[0] ?? 'paypal';
    const valor = Number(captura?.amount?.value);

    return {
      status: captura
        ? statusDaCaptura(captura.status)
        : statusDoPedido(pedido.status),
      method:
        fonte === 'card' ? PaymentMethod.CREDIT_CARD : PaymentMethod.OTHER,
      createdAt: new Date(
        captura?.create_time ?? pedido.create_time ?? Date.now(),
      ),
      // O PayPal fala em reais, em texto ("150.00")
      paidAmountCents: Number.isFinite(valor) ? Math.round(valor * 100) : null,
      payload: {
        payment_method: { type: fonte },
        codeTransaction: captura?.id ?? pedido.id,
        receipt: null,
      },
      raw: pedido,
    };
  }

  private cred(ctx: GatewayContext): PayPalCredenciais {
    return {
      clientId: ctx.credentials.clientId,
      clientSecret: ctx.credentials.clientSecret,
    };
  }
}

/** Centavos para o texto que o PayPal pede: 15000 → "150.00" */
function reais(centavos: number): string {
  return (centavos / 100).toFixed(2);
}

function referenciaDo(pedido: any): string | undefined {
  return pedido?.purchase_units?.[0]?.reference_id;
}

function statusDaCaptura(status?: string): PaymentStatus {
  switch (status) {
    case 'COMPLETED':
    // devolução parcial é acerto feito pela organização no painel; a
    // inscrição continua paga
    case 'PARTIALLY_REFUNDED':
      return PaymentStatus.PAID;
    // e-check não compensado, revisão de risco: o dinheiro ainda não entrou
    case 'PENDING':
      return PaymentStatus.IN_ANALYSIS;
    case 'DECLINED':
    case 'FAILED':
      return PaymentStatus.DECLINED;
    case 'REFUNDED':
      return PaymentStatus.REFUNDED;
    default:
      return PaymentStatus.WAITING;
  }
}

/**
 * Pedido sem captura. `APPROVED` só chega aqui quando a captura foi recusada
 * (cartão negado na hora): o comprador precisa pagar de novo, e "aguardando"
 * é o que deixa o botão de pagar disponível.
 */
function statusDoPedido(status?: string): PaymentStatus {
  return status === 'VOIDED' ? PaymentStatus.CANCELED : PaymentStatus.WAITING;
}
