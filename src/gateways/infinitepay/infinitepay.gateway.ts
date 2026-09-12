import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethod, PaymentProvider, PaymentStatus } from '@prisma/client';
import {
  InfinitePayClient,
  InfinitePayConferencia,
  InfinitePayCredenciais,
} from './infinitepay.client';
import { PaymentGateway } from '../core/payment-gateway.interface';
import { GatewayResourceNotFoundError } from '../core/gateway.errors';
import { aplicarDesconto } from '../core/discount';
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
 * InfinitePay — checkout integrado.
 *
 * A casa mais simples das quatro e a que exige mais cuidado, pela mesma razão:
 * a API não tem autenticação e a notificação não é assinada. O que separa um
 * retorno legítimo de um forjado, aqui, são duas coisas:
 *
 * 1. o segredo na URL de notificação, que só a InfinitePay recebeu;
 * 2. a reconferência pelo `payment_check` — o corpo do POST é tratado como
 *    "vá olhar aquela cobrança", nunca como "aquela cobrança foi paga".
 *
 * Sem a segunda, quem descobrisse a URL de uma igreja quitaria a própria
 * inscrição com um `curl`.
 */
@Injectable()
export class InfinitePayGateway implements PaymentGateway {
  private readonly logger = new Logger(InfinitePayGateway.name);

  constructor(private readonly client: InfinitePayClient) {}

  readonly descriptor: PaymentGatewayDescriptor = {
    provider: PaymentProvider.INFINITEPAY,
    label: 'InfinitePay',
    summary:
      'Checkout integrado da InfinitePay, com Pix e cartão de crédito parcelado.',
    paymentMethods: [PaymentMethod.PIX, PaymentMethod.CREDIT_CARD],
    fields: [
      {
        key: 'handle',
        label: 'InfiniteTag',
        required: true,
        // Não é segredo: o handle aparece na própria URL do checkout que o
        // inscrito abre. Esconder na tela não protegeria nada e só
        // atrapalharia quem administra a conferir se cadastrou o certo.
        secret: false,
        placeholder: '$suaigreja',
        help: 'O mesmo apelido que aparece no seu link de pagamento da InfinitePay.',
      },
    ],
    docsUrl: 'https://www.infinitepay.io/checkout-documentacao',
    signsWebhook: false,
    webhookChannels: [{ key: 'payments', label: 'Notificação de pagamento' }],
  };

  async createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    const itens = aplicarDesconto(pedido.items, pedido.discountCents);

    const resposta = await this.client.createLink(
      {
        // `order_nsu` é a nossa referência do outro lado: é por ele que a
        // conferência reencontra a cobrança.
        order_nsu: pedido.referenceId,
        redirect_url: pedido.redirectUrl,
        webhook_url: pedido.paymentNotificationUrl,
        customer: {
          name: pedido.customer.name,
          email: pedido.customer.email,
          phone_number: `${pedido.customer.phone.area}${pedido.customer.phone.number}`,
        },
        items: itens.map((item) => ({
          quantity: item.quantity,
          price: item.unitAmountCents,
          description: item.description || item.name,
        })),
      },
      this.cred(ctx),
    );

    const url = resposta?.url ?? resposta?.link ?? resposta?.checkout_url ?? '';

    return {
      // A InfinitePay não tem "id do checkout"; o slug do link é o que existe
      // para identificá-lo, e é o que a conferência aceita.
      checkoutId:
        resposta?.slug ?? resposta?.invoice_slug ?? pedido.referenceId,
      payUrl: url,
      raw: resposta,
    };
  }

  async listCharges(
    referenceId: string,
    ctx: GatewayContext,
  ): Promise<GatewayCharge[]> {
    const conferencia = await this.client.paymentCheck(this.cred(ctx), {
      orderNsu: referenceId,
    });

    if (!conferencia?.success) {
      throw new GatewayResourceNotFoundError('InfinitePay', referenceId);
    }

    return [this.paraCharge(conferencia)];
  }

  /**
   * A InfinitePay não oferece cancelamento de link pela API.
   *
   * Não é falha e não pode derrubar o fluxo: o link antigo some da tela do
   * inscrito quando o novo é gerado, e o que impede pagamento em duplicidade é
   * o `PaymentCheckout` inativado deste lado — a reconferência de qualquer
   * retorno posterior cai num checkout que não está mais ativo.
   */
  async inactivateCheckout(): Promise<void> {
    return;
  }

  /**
   * Não há assinatura para conferir: a casa não manda nenhuma.
   *
   * O `true` aqui não é "confio no corpo" — é "a autenticidade desta casa se
   * resolve em outro lugar". O segredo da URL já foi conferido pelo registry
   * antes de chegar neste método, e o conteúdo é reconferido em
   * `parseWebhook`. Documentado no descriptor com `signsWebhook: false`, que é
   * o que a tela mostra a quem cadastra.
   */
  verifyWebhook(): boolean {
    return true;
  }

  async parseWebhook(
    req: WebhookRequest,
    ctx: GatewayContext,
  ): Promise<GatewayWebhookEvent> {
    const body = req.body ?? {};
    const orderNsu = body.order_nsu;

    if (!orderNsu) {
      return { kind: 'ignored', reason: 'notificação sem order_nsu' };
    }

    // O corpo diz qual cobrança olhar; quem diz se ela foi paga é a API.
    const conferencia = await this.client.paymentCheck(this.cred(ctx), {
      orderNsu,
      transactionNsu: body.transaction_nsu,
      slug: body.invoice_slug,
    });

    if (!conferencia?.success) {
      this.logger.warn(
        `InfinitePay — aviso de pagamento para ${orderNsu} não confirmado pela API; ignorado.`,
      );
      return {
        kind: 'ignored',
        reason: 'a InfinitePay não confirmou esta cobrança',
      };
    }

    const charge = this.paraCharge(conferencia);

    return {
      kind: 'payment',
      referenceId: orderNsu,
      status: charge.status,
      method: charge.method,
      paidAmountCents: charge.paidAmountCents,
      payload: {
        payment_method: { type: conferencia.capture_method },
        codeTransaction: body.transaction_nsu ?? null,
        installments: conferencia.installments ?? null,
        receipt: body.receipt_url ?? null,
      },
    };
  }

  async healthCheck(ctx: GatewayContext): Promise<GatewayHealth> {
    const handle = this.cred(ctx).handle?.trim();

    if (!handle) {
      return { ok: false, message: 'Informe o InfiniteTag da conta.' };
    }

    try {
      // Uma referência que não existe: a resposta esperada é `success: false`.
      // Chegar até ela já prova que a API responde e que o handle é aceito.
      await this.client.paymentCheck(this.cred(ctx), {
        orderNsu: `ping-${Date.now()}`,
      });

      return {
        ok: true,
        account: handle,
        message:
          'API da InfinitePay respondendo. Confirme o InfiniteTag: a conta só é ' +
          'validada de verdade no primeiro pagamento.',
      };
    } catch {
      return {
        ok: false,
        message: 'Não foi possível falar com a InfinitePay agora.',
      };
    }
  }

  /**
   * O `paid_amount` não é enfeite aqui — é a metade que falta da conferência.
   *
   * Como criar cobrança nesta casa não exige credencial, "pago: sim" sozinho
   * seria forjável por qualquer inscrito (ver `conferirValorPago`). Quem
   * compara é o serviço de pagamento, que sabe quanto foi cobrado; o trabalho
   * daqui é entregar o número.
   */
  private paraCharge(conferencia: InfinitePayConferencia): GatewayCharge {
    return {
      status: conferencia.paid ? PaymentStatus.PAID : PaymentStatus.WAITING,
      method: mapearMetodo(conferencia.capture_method),
      createdAt: new Date(),
      paidAmountCents:
        typeof conferencia.paid_amount === 'number'
          ? conferencia.paid_amount
          : null,
      raw: conferencia,
    };
  }

  private cred(ctx: GatewayContext): InfinitePayCredenciais {
    return { handle: ctx.credentials.handle };
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
    default:
      return PaymentMethod.OTHER;
  }
}
