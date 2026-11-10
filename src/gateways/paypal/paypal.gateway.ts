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

/** Limites do `qr_expiry` do PayPal, em segundos: de 10 minutos a 72 horas */
const PIX_VALIDADE_MINIMA = 600;
const PIX_VALIDADE_MAXIMA = 259200;

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
 *
 * **Pix é outro pedido.** O PayPal não mostra Pix na página dele: o pedido
 * nasce com `payment_source.pix` e devolve o copia e cola, que o sistema
 * exibe na própria tela. Como o tipo do pedido é decidido na criação, o
 * inscrito escolhe antes (`paymentMethodChoices`) — e só quando a igreja
 * ligou o Pix na configuração, porque a conta PayPal precisa tê-lo
 * habilitado. É o único gateway com essa escolha; os outros oferecem as
 * formas lado a lado na página deles.
 */
@Injectable()
export class PayPalGateway implements PaymentGateway {
  constructor(private readonly client: PayPalClient) {}

  readonly descriptor: PaymentGatewayDescriptor = {
    provider: PaymentProvider.PAYPAL,
    label: 'PayPal',
    summary:
      'Cartão de crédito ou saldo da conta no site do PayPal. Com o Pix habilitado na conta, o inscrito também paga por QR Code, sem sair do sistema.',
    paymentMethods: [PaymentMethod.PIX, PaymentMethod.CREDIT_CARD],
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
      {
        key: 'pix',
        label: 'Aceitar Pix',
        required: false,
        secret: false,
        toggle: true,
        help: 'Ligue só depois de ativar o Pix na conta PayPal (Configurações da conta › Produtos e serviços › Formas de pagamento). Sem isso, quem escolher Pix recebe erro.',
      },
    ],
    docsUrl: 'https://developer.paypal.com/docs/api/orders/v2/',
    // O PayPal assina, mas a assinatura não é o que segura a baixa: ver
    // `verifyWebhook`. `true` aqui é o que diz à tela que o segredo da URL não
    // é a única tranca.
    signsWebhook: true,
    webhookChannels: [{ key: 'payments', label: 'Notificação de pagamento' }],
  };

  paymentMethodChoices(ctx: GatewayContext): PaymentMethod[] {
    return ctx.credentials.pix === 'true'
      ? [PaymentMethod.PIX, PaymentMethod.CREDIT_CARD]
      : [];
  }

  async createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    // O PayPal tem `breakdown.discount`, mas o total cobrado precisa bater
    // com `chargedAmountCents`, que é calculado por `aplicarDesconto` — usar
    // a mesma conta evita dois números diferentes para a mesma cobrança.
    const itens = aplicarDesconto(pedido.items, pedido.discountCents);
    const total = reais(totalEmCentavos(itens));
    const querPix = pedido.paymentMethod === PaymentMethod.PIX;
    const retorno = {
      return_url: pedido.redirectUrl,
      cancel_url: pedido.redirectUrl,
    };

    const segundos = Math.round(
      (pedido.expiresAt.getTime() - Date.now()) / 1000,
    );
    const validadeDoPix = Math.min(
      PIX_VALIDADE_MAXIMA,
      Math.max(PIX_VALIDADE_MINIMA, segundos),
    );

    const payload = {
      intent: 'CAPTURE',
      // No Pix o dinheiro já saiu da conta de quem pagou: não há o que revisar,
      // e o PayPal captura sozinho. No cartão a captura continua sendo nossa.
      ...(querPix && {
        processing_instruction: 'ORDER_COMPLETE_ON_PAYMENT_APPROVAL',
      }),
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
      payment_source: querPix
        ? {
            pix: {
              name: pedido.customer.name,
              country_code: 'BR',
              currency_code: 'BRL',
              phone_number: `${pedido.customer.phone.area}${pedido.customer.phone.number}`,
              email_id: pedido.customer.email,
              tax_info: {
                tax_id: pedido.customer.taxId.replace(/\D/g, ''),
                tax_id_type: 'CPF',
              },
              qr_expiry: String(validadeDoPix),
              experience_context: {
                shipping_preference: 'NO_SHIPPING',
                ...retorno,
              },
            },
          }
        : {
            paypal: {
              experience_context: {
                locale: 'pt-BR',
                shipping_preference: 'NO_SHIPPING',
                // "Pagar agora" em vez de "Continuar": não há tela de revisão
                // nossa depois do PayPal
                user_action: 'PAY_NOW',
                ...retorno,
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

    if (querPix) {
      const pix = criado?.payment_source?.pix;

      return {
        checkoutId: criado?.id,
        // sem página do lado de lá: o link passa a ser a nossa tela do QR.
        // Pedido que voltou sem o código fica sem `pix` e sem link, e quem
        // chama recusa — melhor que mandar o inscrito para um QR vazio.
        payUrl: '',
        pix: pix?.qr_payload
          ? {
              // `qr_payload` é o copia e cola no padrão do Banco Central; o
              // QR é desenhado a partir do mesmo texto
              code: pix.qr_payload,
              expiresAt: new Date(
                Date.now() + (Number(pix.qr_expiry) || validadeDoPix) * 1000,
              ),
            }
          : undefined,
        raw: criado,
      };
    }

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

    const orderId = pedidoCitado(tipo, recurso);

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
      // Sem captura a forma fica em aberto de propósito: a tela trata
      // "aguardando com forma definida" como cobrança em andamento e trava o
      // botão de pagar — e é por ele que o inscrito volta ao QR que fechou, ou
      // tenta de novo depois de um cartão recusado.
      method: captura ? metodoDaFonte(fonte) : PaymentMethod.OTHER,
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

/**
 * O pedido que a notificação cita. Cada família de aviso guarda num lugar: os
 * de pedido trazem o próprio pedido (`CHECKOUT.PAYMENT-APPROVAL.REVERSED`, do
 * Pix expirado ou cancelado, em `order_id`); os de captura trazem a captura,
 * com o pedido em `related_ids` no cartão e só no link `up` no Pix.
 */
function pedidoCitado(tipo: string, recurso: any): string | undefined {
  if (tipo.startsWith('CHECKOUT.')) return recurso.order_id ?? recurso.id;

  if (tipo.startsWith('PAYMENT.CAPTURE.')) {
    return (
      recurso.supplementary_data?.related_ids?.order_id ??
      (recurso.links ?? [])
        .find((l: any) => l.rel === 'up')
        ?.href?.split('/')
        .pop()
    );
  }

  return undefined;
}

function metodoDaFonte(fonte: string): PaymentMethod {
  switch (fonte) {
    case 'pix':
      return PaymentMethod.PIX;
    case 'card':
      return PaymentMethod.CREDIT_CARD;
    // carteira PayPal: saldo ou o que estiver cadastrado na conta
    default:
      return PaymentMethod.OTHER;
  }
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
