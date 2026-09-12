import { Injectable, Logger } from '@nestjs/common';
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
        placeholder: 'APP_USR-… (produção) ou TEST-… (sandbox)',
        help: 'Painel do Mercado Pago › Suas integrações › Credenciais. O prefixo precisa combinar com o ambiente escolhido.',
      },
      {
        key: 'webhookSecret',
        label: 'Assinatura secreta do webhook',
        required: true,
        secret: true,
        help: 'Na mesma tela, em Webhooks: é a chave que assina as notificações. Sem ela o sistema recusa os retornos.',
      },
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

  async listCharges(
    referenceId: string,
    ctx: GatewayContext,
  ): Promise<GatewayCharge[]> {
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
      payload: {
        payment_method: {
          type: pagamento.payment_type_id,
          id: pagamento.payment_method_id,
        },
        codeTransaction: String(pagamento.id),
        receipt: pagamento.transaction_details?.external_resource_url ?? null,
      },
    };
  }

  async healthCheck(ctx: GatewayContext): Promise<GatewayHealth> {
    const cred = this.cred(ctx);

    try {
      const conta = await this.client.me(cred);

      // O prefixo da credencial diz o ambiente. Trocar os dois é o erro mais
      // comum da primeira configuração, e ele só apareceria no primeiro
      // inscrito que tentasse pagar de verdade.
      const ehTeste = cred.accessToken.trim().startsWith('TEST-');
      const esperaTeste = ctx.mode === PaymentProviderMode.SANDBOX;

      if (ehTeste !== esperaTeste) {
        return {
          ok: false,
          account: conta?.nickname,
          message: esperaTeste
            ? 'Este é um token de produção, mas o ambiente selecionado é sandbox.'
            : 'Este é um token de teste (TEST-…), mas o ambiente selecionado é produção.',
        };
      }

      return {
        ok: true,
        account: conta?.nickname ?? conta?.email,
        message: `Conectado à conta ${conta?.nickname ?? conta?.email}.`,
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
      raw: pagamento,
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
      return PaymentMethod.DEBIT_CARD;
    // "ticket" é como o Mercado Pago chama boleto e pagamento em lotérica
    case 'ticket':
      return PaymentMethod.BOLETO;
    default:
      return PaymentMethod.OTHER;
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
