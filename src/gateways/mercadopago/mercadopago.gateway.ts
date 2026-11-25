import {
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentProvider,
  PaymentProviderMode,
  PaymentStatus,
} from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  MercadoPagoClient,
  MercadoPagoCredenciais,
} from './mercadopago.client';
import { PaymentGateway } from '../core/payment-gateway.interface';
import { metodoNaoMapeado } from '../core/gateway-http';
import { GatewayResourceNotFoundError } from '../core/gateway.errors';
import { aplicarDesconto, totalEmCentavos } from '../core/discount';
import {
  campoDeFormas,
  campoDeParcelas,
  campoDeRepasse,
  escolhasComPixNaTela,
  formasDoCheckout,
  formasEscolhidas,
  parcelasEscolhidas,
  PIX_INDISPONIVEL,
  pixIndisponivel,
  querPixNaTela,
} from '../core/opcoes-de-pagamento';
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

/**
 * Mercado Pago — Checkout Pro.
 *
 * O modelo é o mesmo do PagBank: o sistema cria uma "preferência", recebe um
 * link e manda o inscrito para lá. Duas diferenças moldam este arquivo:
 *
 * 1. Não existe campo de desconto na preferência — o abatimento entra no preço
 *    dos itens (ver `aplicarDesconto`).
 * 2. A notificação traz só o id do pagamento. O status é buscado com o token
 *    da igreja, numa segunda chamada. É mais trabalho e é melhor: o corpo do
 *    POST deixa de ser fonte de verdade sobre dinheiro.
 */
/** As formas que a igreja pode ligar e desligar no Checkout Pro */
const FORMAS: PaymentMethod[] = [
  PaymentMethod.PIX,
  PaymentMethod.BOLETO,
  PaymentMethod.CREDIT_CARD,
  PaymentMethod.DEBIT_CARD,
];

/** `payment_type_id` do Mercado Pago. No Brasil o Pix é `bank_transfer`. */
const TIPO_NO_MERCADO_PAGO: Partial<Record<PaymentMethod, string>> = {
  PIX: 'bank_transfer',
  BOLETO: 'ticket',
  CREDIT_CARD: 'credit_card',
  DEBIT_CARD: 'debit_card',
};

@Injectable()
export class MercadoPagoGateway implements PaymentGateway {
  private readonly logger = new Logger(MercadoPagoGateway.name);

  constructor(private readonly client: MercadoPagoClient) {}

  readonly descriptor: PaymentGatewayDescriptor = {
    provider: PaymentProvider.MERCADO_PAGO,
    label: 'Mercado Pago',
    summary:
      'Checkout Pro do Mercado Pago, com Pix, boleto, cartão e saldo em conta.',
    paymentMethods: [
      PaymentMethod.PIX,
      PaymentMethod.BOLETO,
      PaymentMethod.CREDIT_CARD,
      PaymentMethod.DEBIT_CARD,
    ],
    fields: [
      {
        key: 'accessToken',
        label: 'Access token',
        required: true,
        secret: true,
        placeholder: 'APP_USR-…',
        // o caminho no painel e a única troca possível ali. O resto — por que a
        // public key não serve, por que o prefixo não diz o ambiente — está em
        // docs/mercadopago.md, que é onde cabe texto
        help: 'Painel › Suas integrações › Credenciais — o access token, não a public key.',
      },
      {
        key: 'webhookSecret',
        label: 'Assinatura secreta do webhook',
        required: true,
        secret: true,
        // "Order" é o aviso do Pix pago na nossa tela: order não tem URL
        // própria, e sem o evento marcado a baixa espera a conferência
        help: 'Painel › Webhooks. Marque os eventos Pagamentos e Order (Mercado Pago). Sem a assinatura o sistema recusa os retornos.',
      },
      campoDeFormas(FORMAS),
      campoDeParcelas(12),
      campoDeRepasse(FORMAS),
    ],
    docsUrl:
      'https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/landing',
    signsWebhook: true,
    webhookChannels: [{ key: 'payments', label: 'Notificação de pagamento' }],
  };

  async createCheckout(
    pedido: HostedCheckoutRequest,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    const itens = aplicarDesconto(pedido.items, pedido.discountCents);
    const [nome, ...sobrenome] = pedido.customer.name.trim().split(/\s+/);
    const formas = formasEscolhidas(ctx.credentials.enabledMethods, FORMAS);
    const parcelas = parcelasEscolhidas(ctx.credentials.maxInstallments, 12);

    if (querPixNaTela(formas, pedido.paymentMethod)) {
      return this.criarPix(pedido, totalEmCentavos(itens), ctx);
    }

    // o Pix ligado é pago na nossa tela: no checkout ficam as outras
    const doCheckout = formasDoCheckout(formas);

    const payload = {
      external_reference: pedido.referenceId,
      // Vira "Igreja de Cristo" na fatura do cartão do inscrito
      statement_descriptor: pedido.softDescriptor,
      items: itens.map((item) => ({
        id: item.referenceId,
        title: item.name,
        description: item.description,
        quantity: item.quantity,
        currency_id: 'BRL',
        // Reais, e não centavos: é a única das quatro casas que pede assim, e
        // trocar as duas coisas cobra cem vezes o valor certo.
        unit_price: item.unitAmountCents / 100,
      })),
      payer: {
        name: nome,
        surname: sobrenome.join(' ') || nome,
        email: pedido.customer.email,
        identification: { type: 'CPF', number: pedido.customer.taxId },
        phone: {
          area_code: pedido.customer.phone.area,
          number: pedido.customer.phone.number,
        },
      },
      back_urls: {
        success: pedido.redirectUrl,
        failure: pedido.redirectUrl,
        pending: pedido.redirectUrl,
      },
      // O Checkout Pro só sabe excluir: o que a igreja desmarcou sai por tipo.
      // Saldo em conta não sai nunca — o Mercado Pago não deixa.
      payment_methods: {
        excluded_payment_types: FORMAS.filter(
          (f) => !doCheckout.includes(f),
        ).map((f) => ({ id: TIPO_NO_MERCADO_PAGO[f] })),
        ...(parcelas && { installments: parcelas }),
      },
      auto_return: 'approved',
      notification_url: pedido.paymentNotificationUrl,
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: pedido.expiresAt.toISOString(),
    };

    const preferencia = await this.client.createPreference(
      payload,
      this.cred(ctx),
      pedido.referenceId,
    );

    return {
      checkoutId: preferencia.id,
      payUrl: this.linkDePagamento(preferencia, ctx.mode),
      raw: preferencia,
    };
  }

  /** Com Pix ligado, o inscrito escolhe entre o Pix na nossa tela e o checkout */
  paymentMethodChoices(ctx: GatewayContext): PaymentMethod[] {
    return escolhasComPixNaTela(
      formasEscolhidas(ctx.credentials.enabledMethods, FORMAS),
    );
  }

  /**
   * O Pix pago na nossa tela, pela API de orders (`POST /v1/orders`).
   *
   * QR dinâmico: valor e validade desta cobrança, e a order leva a nossa
   * referência em `external_reference`. Duas diferenças da preferência:
   *
   * - não há URL de aviso por order — o aviso chega pela URL cadastrada no
   *   painel, com tipo `order` (ver `parseWebhook`);
   * - os pagamentos de uma order não aparecem na busca de pagamentos, então a
   *   consulta vai pela order, pelo id que guardamos como `checkoutId`.
   */
  private async criarPix(
    pedido: HostedCheckoutRequest,
    totalCentavos: number,
    ctx: GatewayContext,
  ): Promise<HostedCheckoutResult> {
    const [nome, ...sobrenome] = pedido.customer.name.trim().split(/\s+/);
    const total = (totalCentavos / 100).toFixed(2);
    const minutos = Math.max(
      5,
      Math.round((pedido.expiresAt.getTime() - Date.now()) / 60000),
    );

    const order = await this.client
      .createOrder(
        {
          type: 'online',
          processing_mode: 'automatic',
          external_reference: pedido.referenceId,
          total_amount: total,
          description: pedido.eventName.slice(0, 150),
          payer: {
            email: pedido.customer.email,
            first_name: nome,
            last_name: sobrenome.join(' ') || nome,
            identification: {
              type: 'CPF',
              number: pedido.customer.taxId.replace(/\D/g, ''),
            },
          },
          transactions: {
            payments: [
              {
                amount: total,
                payment_method: { id: 'pix', type: 'bank_transfer' },
                expiration_time: `PT${minutos}M`,
              },
            ],
          },
        },
        this.cred(ctx),
        pedido.referenceId,
      )
      .catch((erro) => {
        throw pixIndisponivel(erro);
      });

    const pagamento = order?.transactions?.payments?.[0];
    const code: string | undefined = pagamento?.payment_method?.qr_code;

    if (!code) {
      this.logger.warn(
        `Mercado Pago — order de Pix ${order?.id} sem código (${order?.status}/${order?.status_detail}).`,
      );
      throw new UnprocessableEntityException(PIX_INDISPONIVEL);
    }

    return {
      checkoutId: order.id,
      // sem página do lado de lá: o link é a nossa tela do QR
      payUrl: '',
      pix: {
        code,
        expiresAt: pagamento?.date_of_expiration
          ? new Date(pagamento.date_of_expiration)
          : new Date(Date.now() + minutos * 60000),
      },
      raw: order,
    };
  }

  /**
   * @param checkoutId quando é uma order (`ORD…`, o Pix na nossa tela), a
   * consulta vai por ela: pagamento de order não aparece na busca de
   * pagamentos por referência.
   */
  async listCharges(
    referenceId: string,
    ctx: GatewayContext,
    checkoutId?: string,
  ): Promise<GatewayCharge[]> {
    if (ehOrder(checkoutId)) {
      const order = await this.client.getOrder(checkoutId, this.cred(ctx));
      if (!order)
        throw new GatewayResourceNotFoundError('Mercado Pago', referenceId);
      return [this.paraChargeDaOrder(order)];
    }

    const pagamentos = await this.client.searchPayments(
      referenceId,
      this.cred(ctx),
    );

    // Lista vazia é "o link foi criado e ninguém tentou pagar" — o mesmo caso
    // que o PagBank responde com 404. O contrato pede o erro tipado para que
    // quem chama distinga isso de uma casa fora do ar.
    if (pagamentos.length === 0) {
      throw new GatewayResourceNotFoundError('Mercado Pago', referenceId);
    }

    return pagamentos.map((pagamento) => this.paraCharge(pagamento));
  }

  async inactivateCheckout(checkoutId: string, ctx: GatewayContext) {
    // o Pix substituído: a order não paga é cancelada, para o QR antigo não
    // receber depois de outro ter sido gerado
    if (ehOrder(checkoutId)) {
      await this.client.cancelOrder(checkoutId, this.cred(ctx));
      return;
    }

    await this.client.expirePreference(checkoutId, this.cred(ctx));
  }

  /**
   * `x-signature: ts=<carimbo>,v1=<hmac>` sobre o texto
   * `id:<data.id>;request-id:<x-request-id>;ts:<carimbo>;`.
   *
   * O corpo não entra na assinatura — o que o Mercado Pago autentica é o
   * ponteiro para o pagamento, não o conteúdo. Daí `parseWebhook` ir buscar o
   * status na API em vez de ler o corpo.
   */
  verifyWebhook(req: WebhookRequest, ctx: GatewayContext): boolean {
    const segredo = this.cred(ctx).webhookSecret?.trim();

    // Sem a assinatura secreta cadastrada não há como distinguir um retorno
    // legítimo de um POST forjado. Recusar é o lado seguro do erro.
    if (!segredo) {
      this.logger.warn(
        'Mercado Pago — notificação recusada: a igreja não cadastrou a assinatura secreta.',
      );
      return false;
    }

    const assinatura = cabecalho(req, 'x-signature');
    const requestId = cabecalho(req, 'x-request-id');
    const dataId = this.idDoPagamento(req);

    if (!assinatura || !dataId) return false;

    const partes = new Map(
      assinatura.split(',').map((p) => {
        const [chave, ...resto] = p.split('=');
        return [chave.trim(), resto.join('=').trim()];
      }),
    );

    const ts = partes.get('ts');
    const v1 = partes.get('v1');
    if (!ts || !v1) return false;

    // O id entra em minúsculas quando tem letras; a doc do Mercado Pago é
    // explícita nisso e a assinatura não bate sem essa normalização.
    const manifesto = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;

    const esperado = createHmac('sha256', segredo)
      .update(manifesto)
      .digest('hex');

    const a = Buffer.from(v1, 'utf8');
    const b = Buffer.from(esperado, 'utf8');

    return a.length === b.length && timingSafeEqual(a as any, b as any);
  }

  async parseWebhook(
    req: WebhookRequest,
    ctx: GatewayContext,
  ): Promise<GatewayWebhookEvent> {
    const tipo = req.body?.type ?? req.body?.topic ?? req.query?.type;

    // O Pix na nossa tela é uma order, e o aviso dela vem com tipo `order`. O
    // corpo só aponta a order; o estado vem da API, com a nossa credencial.
    if (tipo === 'order') {
      const orderId = this.idDoPagamento(req);
      const order = orderId
        ? await this.client.getOrder(orderId, this.cred(ctx))
        : null;

      if (!order?.external_reference) {
        return {
          kind: 'ignored',
          reason: 'order sem referência externa — não é deste sistema',
        };
      }

      const charge = this.paraChargeDaOrder(order);
      return {
        kind: 'payment',
        referenceId: order.external_reference,
        status: charge.status,
        method: charge.method,
        paidAmountCents: charge.paidAmountCents,
        payload: charge.payload,
      };
    }

    // Chegam avisos de estorno, contestação e pedido comercial na mesma URL
    if (tipo !== 'payment') {
      return { kind: 'ignored', reason: `notificação do tipo ${tipo}` };
    }

    const paymentId = this.idDoPagamento(req);
    if (!paymentId) {
      return { kind: 'ignored', reason: 'notificação sem id de pagamento' };
    }

    const pagamento = await this.client.getPayment(paymentId, this.cred(ctx));

    if (!pagamento?.external_reference) {
      return {
        kind: 'ignored',
        reason: 'pagamento sem referência externa — não é deste sistema',
      };
    }

    const charge = this.paraCharge(pagamento);

    return {
      kind: 'payment',
      referenceId: pagamento.external_reference,
      status: charge.status,
      method: charge.method,
      paidAmountCents: charge.paidAmountCents,
      payload: charge.payload,
    };
  }

  async healthCheck(ctx: GatewayContext): Promise<GatewayHealth> {
    const cred = this.cred(ctx);

    try {
      const conta = await this.client.me(cred);
      const nome = conta?.nickname ?? conta?.email;

      /**
       * O prefixo não diz mais o ambiente.
       *
       * A documentação do Mercado Pago é explícita: "o Access Token de teste
       * começa com o prefixo `APP_USR`" — o mesmo das credenciais de produção.
       * Enquanto esta conferência procurava `TEST-`, toda credencial de teste
       * de hoje era anunciada como de produção, e a configuração certa era
       * recusada na cara do admin.
       *
       * Sobrou o caso em que o prefixo ainda prova alguma coisa: `TEST-` é o
       * formato antigo, e token nesse formato é de teste, ponto. No outro
       * sentido não há o que afirmar, então a conta conectada vai na resposta
       * e quem reconhece o vendedor é o admin.
       */
      const ehTesteAntigo = cred.accessToken.trim().startsWith('TEST-');

      if (ehTesteAntigo && ctx.mode === PaymentProviderMode.PRODUCTION) {
        return {
          ok: false,
          account: conta?.nickname,
          message:
            'Este é um token de teste (TEST-…), mas o ambiente selecionado é produção.',
        };
      }

      return {
        ok: true,
        account: nome,
        message:
          ctx.mode === PaymentProviderMode.SANDBOX
            ? `Conectado à conta ${nome}. O token não diz se é de teste: confira se esta é a conta de teste do vendedor.`
            : `Conectado à conta ${nome}.`,
      };
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.warn(`Mercado Pago — teste de credencial falhou: ${status}`);

      return {
        ok: false,
        message:
          status === 401 || status === 403
            ? 'O Mercado Pago recusou este access token.'
            : 'Não foi possível falar com o Mercado Pago agora.',
      };
    }
  }

  /**
   * O link do checkout. `sandbox_init_point` é um endereço diferente, e usar o
   * de produção com credencial de teste leva o inscrito a uma tela de erro.
   */
  private linkDePagamento(preferencia: any, mode: PaymentProviderMode): string {
    return mode === PaymentProviderMode.SANDBOX
      ? preferencia.sandbox_init_point ?? preferencia.init_point ?? ''
      : preferencia.init_point ?? '';
  }

  /** O id vem na query (`data.id`) ou no corpo, dependendo da versão do webhook */
  private idDoPagamento(req: WebhookRequest): string {
    const bruto =
      req.query?.['data.id'] ??
      req.query?.id ??
      req.body?.data?.id ??
      req.body?.resource;

    if (bruto === undefined || bruto === null) return '';

    // Em avisos antigos o `resource` vem como URL inteira; o id é o fim dela
    return String(bruto).split('/').filter(Boolean).pop() ?? '';
  }

  private paraCharge(pagamento: any): GatewayCharge {
    // A única das quatro que fala em reais; converter na leitura evita que a
    // conferência de valor compare centavo com real e recuse todo pagamento.
    const pagoEmReais =
      pagamento.transaction_details?.total_paid_amount ??
      pagamento.transaction_amount;

    return {
      status: mapearStatus(pagamento.status),
      method: mapearMetodo(pagamento.payment_type_id),
      createdAt: new Date(pagamento.date_created ?? Date.now()),
      paidAmountCents:
        typeof pagoEmReais === 'number' ? Math.round(pagoEmReais * 100) : null,
      payload: {
        payment_method: {
          type: pagamento.payment_type_id,
          id: pagamento.payment_method_id,
        },
        codeTransaction: String(pagamento.id),
        receipt: pagamento.transaction_details?.external_resource_url ?? null,
      },
      raw: pagamento,
    };
  }

  /** A order como cobrança: o estado e o valor são os da order inteira */
  private paraChargeDaOrder(order: any): GatewayCharge {
    const pagamento = order?.transactions?.payments?.[0];
    // reais em texto ("120.00"), como tudo na API de orders
    const pago = Number(order?.total_paid_amount);

    return {
      status: mapearStatusDaOrder(order?.status),
      method: mapearMetodo(pagamento?.payment_method?.type),
      createdAt: new Date(
        order?.created_date ?? order?.date_created ?? Date.now(),
      ),
      paidAmountCents:
        order?.total_paid_amount !== undefined && Number.isFinite(pago)
          ? Math.round(pago * 100)
          : null,
      payload: {
        payment_method: {
          type: pagamento?.payment_method?.type,
          id: pagamento?.payment_method?.id,
        },
        codeTransaction: String(pagamento?.id ?? order?.id),
        receipt: pagamento?.payment_method?.ticket_url ?? null,
      },
      raw: order,
    };
  }

  private cred(ctx: GatewayContext): MercadoPagoCredenciais {
    return {
      accessToken: ctx.credentials.accessToken,
      webhookSecret: ctx.credentials.webhookSecret,
    };
  }
}

function mapearMetodo(tipo?: string): PaymentMethod {
  switch (tipo) {
    // Pix chega como transferência bancária; não há tipo próprio para ele
    case 'bank_transfer':
      return PaymentMethod.PIX;
    case 'credit_card':
      return PaymentMethod.CREDIT_CARD;
    case 'debit_card':
    // pré-pago desconta de um saldo carregado antes, como o débito
    case 'prepaid_card':
      return PaymentMethod.DEBIT_CARD;
    // saldo da conta, Linha de Crédito Mercado Pago e carteiras: o dinheiro
    // saiu da conta do comprador no próprio Mercado Pago
    case 'account_money':
    case 'digital_currency':
    case 'digital_wallet':
      return PaymentMethod.WALLET;
    // "ticket" é como o Mercado Pago chama boleto e pagamento em lotérica
    case 'ticket':
      return PaymentMethod.BOLETO;
    default:
      return metodoNaoMapeado('Mercado Pago', tipo);
  }
}

/** Order do Pix na nossa tela: `ORD…`. Preferência tem outro formato. */
function ehOrder(checkoutId?: string): checkoutId is string {
  return !!checkoutId && checkoutId.startsWith('ORD');
}

/**
 * Estados da order (documentação "Status de order"). Pago é `processed`
 * (`accredited`); Pix esperando é `action_required` (`waiting_transfer`);
 * expirado vem como `canceled` ou `failed` com detalhe `expired`.
 */
function mapearStatusDaOrder(status?: string): PaymentStatus {
  switch (status) {
    case 'processed':
      return PaymentStatus.PAID;
    case 'processing':
      return PaymentStatus.IN_ANALYSIS;
    case 'canceled':
      return PaymentStatus.CANCELED;
    case 'failed':
      return PaymentStatus.DECLINED;
    case 'refunded':
    case 'charged_back':
      return PaymentStatus.REFUNDED;
    // `created` e `action_required`: ainda não pago
    default:
      return PaymentStatus.WAITING;
  }
}

function mapearStatus(status?: string): PaymentStatus {
  switch (status) {
    case 'approved':
      return PaymentStatus.PAID;
    // `authorized` é cartão preso na maquininha do Mercado Pago: o dinheiro
    // está reservado e ainda não capturado — análise, e não pagamento.
    case 'authorized':
    case 'in_process':
    case 'in_mediation':
      return PaymentStatus.IN_ANALYSIS;
    case 'rejected':
      return PaymentStatus.DECLINED;
    case 'cancelled':
      return PaymentStatus.CANCELED;
    case 'refunded':
    case 'charged_back':
      return PaymentStatus.REFUNDED;
    default:
      return PaymentStatus.WAITING;
  }
}
