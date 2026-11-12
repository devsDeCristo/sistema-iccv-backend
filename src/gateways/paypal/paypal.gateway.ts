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
import { PayPalClient, PayPalCredenciais } from './paypal.client';
import { PaymentGateway } from '../core/payment-gateway.interface';
import { metodoNaoMapeado } from '../core/gateway-http';
import {
  GatewayRequestError,
  GatewayResourceNotFoundError,
} from '../core/gateway.errors';
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
      'Cartão de crédito, débito ou saldo da conta no site do PayPal. Com o Pix habilitado na conta, o inscrito também paga por QR Code, sem sair do sistema.',
    paymentMethods: [
      PaymentMethod.PIX,
      PaymentMethod.CREDIT_CARD,
      PaymentMethod.DEBIT_CARD,
    ],
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
            /**
             * Os nomes são os que a API aceita, e não os da documentação do
             * Pix: ela fala em `email_id`, `phone_number` e `tax_id_type:
             * "CPF"`, e a API recusou os três (400, produção, 11/11/2026),
             * pedindo `email`, `phone` e o `BR_CPF` do `tax_info` padrão.
             * O `phone` segue o tipo `phone` padrão da API (código do país +
             * número nacional) — o único dos três que o erro não detalhou.
             */
            pix: {
              name: pedido.customer.name,
              country_code: 'BR',
              currency_code: 'BRL',
              phone: {
                country_code: pedido.customer.phone.country || '55',
                national_number: `${pedido.customer.phone.area}${pedido.customer.phone.number}`,
              },
              email: pedido.customer.email,
              tax_info: {
                tax_id: pedido.customer.taxId.replace(/\D/g, ''),
                tax_id_type: 'BR_CPF',
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
              // o formulário de cartão já abre preenchido com o cadastro
              ...dadosDoInscrito(pedido.customer),
              experience_context: {
                locale: 'pt-BR',
                shipping_preference: 'NO_SHIPPING',
                // "Pagar agora" em vez de "Continuar": não há tela de revisão
                // nossa depois do PayPal
                user_action: 'PAY_NOW',
                // Abre no formulário de cartão, com "Entrar no PayPal" como
                // alternativa. Sem isto o PayPal escolhia a tela de login, e o
                // inscrito que não tem conta — a maioria — parava ali. Se a
                // conta da igreja não aceita pagamento sem login ("Conta
                // PayPal opcional" desligada), o PayPal mostra o login mesmo
                // assim: é configuração dela, não deste pedido.
                landing_page: 'GUEST_CHECKOUT',
                ...retorno,
              },
            },
          },
    };

    const criado = await this.client
      .createOrder(payload, this.cred(ctx), ctx.mode, pedido.referenceId)
      .catch((erro) => {
        if (querPix) throw pixRecusado(erro);
        if (!recusouOsDados(erro)) throw erro;

        // O preenchimento é conveniência: um cadastro que o PayPal não aceita
        // (CEP, telefone) não pode impedir o pagamento. Segunda tentativa sem
        // os dados, com outro Request-Id — o primeiro já tem resposta guardada.
        new Logger(PayPalGateway.name).warn(
          `PayPal — dados do inscrito recusados em ${pedido.referenceId}; pedido refeito sem eles.`,
        );
        const { experience_context } = (payload.payment_source as any).paypal;
        return this.client.createOrder(
          { ...payload, payment_source: { paypal: { experience_context } } },
          this.cred(ctx),
          ctx.mode,
          `${pedido.referenceId}-sem-dados`,
        );
      });

    if (querPix) {
      const pix = criado?.payment_source?.pix;
      // só nos campos do QR: o resto do `pix` é do inscrito, e um CPF que
      // comece com 000.201 casaria com o prefixo do BR Code
      const code = codigoDoPix(pix?.qr_payload) ?? codigoDoPix(pix?.qr_details);

      if (!code) {
        // Só o QR e com os textos cortados: o formato aparece, e nenhum dado
        // do inscrito vai para o log. O id acha o pedido no painel do PayPal.
        new Logger(PayPalGateway.name).warn(
          `PayPal — pedido de Pix ${criado?.id} (${
            criado?.status
          }) voltou sem o código; campos do pix: ${Object.keys(pix ?? {}).join(
            ', ',
          )}; qr_details: ${JSON.stringify(pix?.qr_details, (_, valor) =>
            typeof valor === 'string' ? valor.slice(0, 12) : valor,
          )}`,
        );
        // melhor que mandar o inscrito para um QR vazio; o pedido do lado
        // de lá expira sozinho
        throw new UnprocessableEntityException(PIX_INDISPONIVEL);
      }

      return {
        checkoutId: criado?.id,
        // sem página do lado de lá: o link passa a ser a nossa tela do QR
        payUrl: '',
        pix: {
          // o QR é desenhado a partir do mesmo texto do copia e cola
          code,
          expiresAt: new Date(
            Date.now() + (Number(pix.qr_expiry) || validadeDoPix) * 1000,
          ),
        },
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

    /**
     * "Aguardando" no PayPal é sempre "nada aconteceu": Pix expirado ou
     * cancelado, cartão recusado na captura. Aplicar isso não mudaria o status
     * e ainda carimbaria a cobrança como vinda do gateway — o que trava a
     * edição na tela e impede a tesouraria de quitar à mão quem acabou pagando
     * em dinheiro. Nos outros gateways "aguardando" pode trazer forma definida
     * (boleto gerado) e significa cobrança em andamento; aqui, nunca.
     */
    if (charge.status === PaymentStatus.WAITING) {
      return {
        kind: 'ignored',
        reason: `pedido ${pedido.id} ainda sem pagamento (${pedido.status})`,
      };
    }

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
      method: captura
        ? metodoDaFonte(fonte, pedido.payment_source?.[fonte])
        : PaymentMethod.OTHER,
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

/**
 * O PayPal recebeu o pedido de Pix e disse não — dado inválido, conta sem Pix
 * habilitado, aplicação sem acesso. Para o inscrito isso não é "o PayPal está
 * fora do ar", que é o que a mensagem genérica dá a entender: é "o Pix não
 * está disponível, pague com cartão". O detalhe continua no log, escrito por
 * `falhaDoGateway` no cliente.
 *
 * Falha de rede e erro 5xx do PayPal seguem com a mensagem genérica: ali
 * tentar de novo em alguns minutos é mesmo a saída.
 */
const RECUSAS_DO_PAYPAL = new Set([
  'INVALID_REQUEST',
  'UNPROCESSABLE_ENTITY',
  'NOT_AUTHORIZED',
  'PERMISSION_DENIED',
]);

function pixRecusado(erro: unknown) {
  if (!(erro instanceof GatewayRequestError)) return erro;

  const resposta = erro.detalhes as { name?: string } | undefined;

  if (RECUSAS_DO_PAYPAL.has(resposta?.name ?? '')) {
    return new UnprocessableEntityException(PIX_INDISPONIVEL);
  }

  return erro;
}

/**
 * O cadastro do inscrito no formato do `payment_source.paypal`, para o
 * formulário de cartão abrir preenchido. Cada campo só vai quando está
 * completo: mandar meio dado faz o PayPal recusar o pedido inteiro.
 */
function dadosDoInscrito(cliente: HostedCheckoutRequest['customer']) {
  const [nome, ...sobrenome] = cliente.name.trim().split(/\s+/);
  const cpf = cliente.taxId.replace(/\D/g, '');
  const celular = `${cliente.phone.area}${cliente.phone.number}`.replace(
    /\D/g,
    '',
  );
  const endereco = cliente.address;
  const cep = (endereco?.zipCode ?? '').replace(/\D/g, '');
  const uf = (endereco?.state ?? '').trim().toUpperCase();
  const enderecoCompleto =
    endereco?.street &&
    endereco.city &&
    cep.length === 8 &&
    /^[A-Z]{2}$/.test(uf);

  return {
    email_address: cliente.email,
    name: {
      given_name: nome.slice(0, 140),
      ...(sobrenome.length && {
        surname: sobrenome.join(' ').slice(0, 140),
      }),
    },
    ...(cpf.length === 11 && {
      tax_info: { tax_id: cpf, tax_id_type: 'BR_CPF' },
    }),
    ...(celular.length >= 10 && {
      phone: {
        phone_type: 'MOBILE',
        phone_number: { national_number: celular },
      },
    }),
    ...(cliente.birthDate && {
      birth_date: cliente.birthDate.toISOString().slice(0, 10),
    }),
    ...(enderecoCompleto && {
      address: {
        address_line_1: [endereco.street, endereco.number]
          .filter(Boolean)
          .join(', '),
        ...(endereco.neighborhood && {
          address_line_2: endereco.neighborhood,
        }),
        admin_area_2: endereco.city,
        admin_area_1: uf,
        postal_code: `${cep.slice(0, 5)}-${cep.slice(5)}`,
        country_code: 'BR',
      },
    }),
  };
}

/** O PayPal recusou o pedido por um dos dados do inscrito, e não pelo resto */
function recusouOsDados(erro: unknown) {
  if (!(erro instanceof GatewayRequestError)) return false;

  const detalhes =
    (erro.detalhes as { details?: { field?: string }[] } | undefined)
      ?.details ?? [];

  return detalhes.some(
    ({ field = '' }) =>
      field.startsWith('/payment_source/paypal/') &&
      !field.startsWith('/payment_source/paypal/experience_context'),
  );
}

const PIX_INDISPONIVEL =
  'O Pix não está disponível agora. Escolha cartão ou conta PayPal.';

/**
 * O copia e cola do Pix. A documentação diz `pix.qr_payload`; a produção
 * devolveu `pix.qr_details`, sem documentação do que vai dentro (11/11/2026).
 * Por isso a busca é pelo conteúdo, não pelo nome do campo: o BR Code do
 * Banco Central sempre começa com "000201" (o indicador de formato do padrão
 * EMV). O `qr_image` do exemplo deles (`pix://pay?…`) não casa.
 */
function codigoDoPix(pix: unknown): string | undefined {
  if (typeof pix === 'string')
    return pix.startsWith('000201') ? pix : undefined;
  if (!pix || typeof pix !== 'object') return undefined;

  for (const valor of Object.values(pix)) {
    const codigo = codigoDoPix(valor);
    if (codigo) return codigo;
  }
  return undefined;
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

/**
 * A forma de pagamento, pelo `payment_source` do pedido.
 *
 * Pela conta PayPal o PayPal não diz de onde o dinheiro saiu (saldo ou cartão
 * salvo na conta): a API de pedidos devolve só a conta. O que se sabe é que foi
 * pela conta — e isso é `WALLET`, não `OTHER`, que no sistema também quer dizer
 * "forma ainda não definida".
 */
function metodoDaFonte(fonte: string, detalhe?: any): PaymentMethod {
  switch (fonte) {
    case 'pix':
      return PaymentMethod.PIX;
    // cartão digitado na página do PayPal, sem login: o PayPal informa o tipo
    case 'card':
      return detalhe?.type === 'DEBIT'
        ? PaymentMethod.DEBIT_CARD
        : PaymentMethod.CREDIT_CARD;
    case 'paypal':
    case 'venmo':
      return PaymentMethod.WALLET;
    default:
      return metodoNaoMapeado('PayPal', fonte);
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
