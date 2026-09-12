import { Injectable, Logger } from '@nestjs/common';
import {
  CheckoutStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PagbankClient, PagbankCredenciais } from './pagbank.client';
import { CreatePagbankCheckoutDto } from './dto/create-checkout.dto';
import { PaymentGateway } from '../core/payment-gateway.interface';
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
 * PagBank (PagSeguro) — a casa que já estava em produção.
 *
 * O corpo do checkout, a escolha do link `PAY` e o vocabulário de status são
 * os mesmos de antes: este arquivo é a mudança de endereço da lógica testada,
 * não uma reescrita dela. O que é novo aqui é a conferência da assinatura do
 * retorno, que não existia — até então qualquer POST na URL de notificação era
 * aceito como se fosse do PagBank.
 */
@Injectable()
export class PagbankGateway implements PaymentGateway {
  private readonly logger = new Logger(PagbankGateway.name);

  constructor(private readonly client: PagbankClient) {}

  readonly descriptor: PaymentGatewayDescriptor = {
    provider: PaymentProvider.PAGBANK,
    label: 'PagBank',
    summary:
      'Checkout hospedado do PagBank, com Pix, boleto e cartão de crédito e débito.',
    paymentMethods: [
      PaymentMethod.PIX,
      PaymentMethod.BOLETO,
      PaymentMethod.CREDIT_CARD,
      PaymentMethod.DEBIT_CARD,
    ],
    fields: [
      {
        key: 'token',
        label: 'Token da API',
        required: true,
        secret: true,
        placeholder: '········',
        help: 'No portal do PagBank: Venda online › Integrações › Gerar token. O mesmo token assina as notificações.',
      },
      {
        key: 'baseUrl',
        label: 'URL da API (opcional)',
        required: false,
        secret: false,
        allowedHostSuffixes: ['pagseguro.com', 'pagbank.com.br'],
        help: 'Deixe em branco para usar o endereço oficial do ambiente escolhido.',
      },
    ],
    docsUrl: 'https://developer.pagbank.com.br/reference/criar-checkout',
    signsWebhook: true,
    webhookChannels: [
      { key: 'payments', label: 'Notificação de pagamento' },
      { key: 'checkouts', label: 'Notificação de checkout' },
    ],
  };

  async createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    const payload: CreatePagbankCheckoutDto = {
      reference_id: pedido.referenceId,
      soft_descriptor: pedido.softDescriptor,
      expiration_date: pedido.expiresAt.toISOString(),
      payment_notification_urls: [pedido.paymentNotificationUrl],
      notification_urls: [pedido.checkoutNotificationUrl],
      redirect_url: pedido.redirectUrl,
      return_url: pedido.redirectUrl,
      customer_modifiable: false,
      customer: {
        name: pedido.customer.name,
        email: pedido.customer.email,
        tax_id: pedido.customer.taxId,
        phone: pedido.customer.phone,
      },
      discount_amount: pedido.discountCents,
      items: pedido.items.map((item) => ({
        reference_id: item.referenceId,
        description: item.description,
        name: item.name,
        quantity: item.quantity,
        unit_amount: item.unitAmountCents,
      })),
      payment_methods: [
        { type: 'CREDIT_CARD' },
        { type: 'DEBIT_CARD' },
        { type: 'BOLETO' },
        { type: 'PIX' },
      ],
    };

    const resultado = await this.client.createCheckout(
      payload,
      this.cred(ctx),
      ctx.mode,
    );

    return {
      checkoutId: resultado.id,
      payUrl: resultado.links?.find((l: any) => l.rel === 'PAY')?.href ?? '',
      raw: resultado,
    };
  }

  async listCharges(
    referenceId: string,
    ctx: GatewayContext,
  ): Promise<GatewayCharge[]> {
    const charges = await this.client.getCharges(
      referenceId,
      this.cred(ctx),
      ctx.mode,
    );

    return charges.map((charge) => ({
      status: mapearStatus(charge.status),
      method: mapearMetodo(charge.payment_method?.type),
      createdAt: new Date(charge.created_at),
      paidAmountCents: valorPago(charge),
      raw: charge,
    }));
  }

  async inactivateCheckout(checkoutId: string, ctx: GatewayContext) {
    await this.client.inactivateCheckout(checkoutId, this.cred(ctx), ctx.mode);
  }

  /**
   * `x-authenticity-token` = SHA-256 de `token-corpo`, com o corpo byte a byte
   * como chegou.
   *
   * Reserializar o JSON não funciona: `JSON.stringify` reordena chaves e some
   * com espaços, e o hash do corpo remontado não bate com o do corpo enviado.
   * Daí o `rawBody` no contrato do webhook.
   */
  verifyWebhook(req: WebhookRequest, ctx: GatewayContext): boolean {
    const recebido = cabecalho(req, 'x-authenticity-token');
    if (!recebido) return false;

    const esperado = createHash('sha256')
      .update(`${this.cred(ctx).token.trim()}-${req.rawBody.toString('utf8')}`)
      .digest('hex');

    // Comparação insensível a caixa: o PagBank envia em minúsculas, mas o
    // valor é hex e não há por que depender disso.
    return recebido.toLowerCase() === esperado.toLowerCase();
  }

  /**
   * Traduz os dois formatos que o PagBank manda.
   *
   * A escolha da cobrança é a mesma de antes: PAID tem prioridade absoluta
   * sobre qualquer outra, e sem PAID vale a mais recente. Sem essa regra, uma
   * tentativa recusada chegando depois da aprovada derrubaria um pagamento
   * que já entrou.
   */
  async parseWebhook(req: WebhookRequest): Promise<GatewayWebhookEvent> {
    const body = req.body ?? {};

    // Notificação de checkout: traz o id e o estado do próprio checkout
    if (!body.charges && body.status && body.id) {
      return {
        kind: 'checkout',
        checkoutId: body.id,
        status: mapearStatusDeCheckout(body.status),
      };
    }

    const charges: any[] = body.charges ?? [];
    if (charges.length === 0) {
      return { kind: 'ignored', reason: 'notificação sem cobranças' };
    }

    const pago = charges.find((c) => c.status === 'PAID');
    const escolhida =
      pago ??
      [...charges].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )[0];

    if (!escolhida) {
      return { kind: 'ignored', reason: 'nenhuma cobrança utilizável' };
    }

    return {
      kind: 'payment',
      referenceId: escolhida.reference_id,
      status: mapearStatus(escolhida.status),
      method: mapearMetodo(escolhida.payment_method?.type),
      paidAmountCents: valorPago(escolhida),
      payload: {
        payment_method: escolhida.payment_method,
        links: escolhida.links,
        codeTransaction: escolhida.id,
      },
    };
  }

  async healthCheck(ctx: GatewayContext): Promise<GatewayHealth> {
    try {
      await this.client.ping(this.cred(ctx), ctx.mode);
      return { ok: true, message: 'Token aceito pelo PagBank.' };
    } catch (err: any) {
      // 404 é sucesso disfarçado: a referência inventada não existe mesmo, e
      // chegar até essa resposta significa que o token passou pela porta.
      if (err?.response?.status === 404 || err?.status === 404) {
        return { ok: true, message: 'Token aceito pelo PagBank.' };
      }

      const status = err?.response?.status ?? err?.status;
      this.logger.warn(`PagBank — teste de credencial falhou: ${status}`);

      return {
        ok: false,
        message:
          status === 401 || status === 403
            ? 'O PagBank recusou este token. Confira se ele é do ambiente selecionado.'
            : 'Não foi possível falar com o PagBank agora.',
      };
    }
  }

  private cred(ctx: GatewayContext): PagbankCredenciais {
    return {
      token: ctx.credentials.token,
      baseUrl: ctx.credentials.baseUrl,
    };
  }
}

/** Quanto entrou, em centavos — a API já devolve nessa unidade */
function valorPago(charge: any): number | null {
  const pago = charge?.amount?.summary?.paid;
  return typeof pago === 'number' ? pago : null;
}

/** Primeiro valor de um cabeçalho, sem depender da caixa que o remetente usou */
export function cabecalho(req: WebhookRequest, nome: string): string {
  const valor = req.headers[nome] ?? req.headers[nome.toLowerCase()];
  return (Array.isArray(valor) ? valor[0] : valor) ?? '';
}

function mapearMetodo(metodo?: string): PaymentMethod {
  switch (metodo) {
    case 'PIX':
      return PaymentMethod.PIX;
    case 'CREDIT_CARD':
      return PaymentMethod.CREDIT_CARD;
    case 'DEBIT_CARD':
      return PaymentMethod.DEBIT_CARD;
    case 'CASH':
      return PaymentMethod.CASH;
    case 'BOLETO':
      return PaymentMethod.BOLETO;
    default:
      return PaymentMethod.OTHER;
  }
}

function mapearStatus(status?: string): PaymentStatus {
  switch (status) {
    case 'PAID':
      return PaymentStatus.PAID;
    case 'IN_ANALYSIS':
      return PaymentStatus.IN_ANALYSIS;
    case 'DECLINED':
      return PaymentStatus.DECLINED;
    case 'CANCELED':
      return PaymentStatus.CANCELED;
    case 'REFUNDED':
      return PaymentStatus.REFUNDED;
    default:
      return PaymentStatus.WAITING;
  }
}

function mapearStatusDeCheckout(status?: string): CheckoutStatus {
  switch (status) {
    case 'ACTIVE':
      return CheckoutStatus.ACTIVE;
    case 'EXPIRED':
      return CheckoutStatus.EXPIRED;
    case 'INACTIVE':
      return CheckoutStatus.INACTIVE;
    default:
      return CheckoutStatus.INACTIVE;
  }
}
