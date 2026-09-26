import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ADMIN_AREA_ROLES, Role } from 'src/auth/roles';
import { SELECT_TENANT, tenantChurchIds } from 'src/auth/tenant';
import {
  CheckoutStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentReceived,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { CreatePaymentCheckoutDto } from './dto/create-payment-checkout.dto';
import {
  GatewayResolvido,
  PaymentGatewayRegistry,
} from 'src/gateways/core/payment-gateway.registry';
import { GatewayResourceNotFoundError } from 'src/gateways/core/gateway.errors';
import { HostedCheckoutRequest } from 'src/gateways/core/gateway.types';
import { totalCobradoEmCentavos } from 'src/gateways/core/discount';
import { conferirValorPago } from './amount-check';
import {
  CANAL_DE_CHECKOUT,
  CANAL_DE_PAGAMENTO,
  montarUrlDeWebhook,
} from 'src/gateways/core/webhook-url';
import { randomUUID } from 'crypto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { ListPaymentLogsDto } from './dto/list-payment-logs.dto';
import { uploadImageFirebase } from 'src/utils/uploadImgFirebase';
import {
  STATUS_QUE_LIBERAM_ESTOQUE,
  emTransacaoSerializavel,
  reativarCompras,
} from 'src/event/event-products';
/**
 * Os estados que só se alcançam quando alguém declara, pela mão, que o
 * dinheiro chegou ou está a caminho: baixa direta e comprovante anexado.
 */
const ENTRADAS_MANUAIS: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.IN_ANALYSIS,
];

/**
 * A edição pela tela é um lançamento manual, ou só um acerto de registro?
 *
 * `receivedFrom` diz **por onde o dinheiro entrou**, e não quem mexeu na
 * linha. Recusar, cancelar, estornar ou corrigir um método não mudam a origem
 * do dinheiro — e o carimbo incondicional que existia aqui apagava o fato de
 * a cobrança ter vindo do gateway: um pagamento do PagBank, depois estornado,
 * passava a se apresentar como lançamento manual para sempre, sem que nada
 * guardasse a verdade anterior.
 */
function ehLancamentoManual(anterior: PaymentStatus, novo?: PaymentStatus) {
  return !!novo && novo !== anterior && ENTRADAS_MANUAIS.includes(novo);
}

const ACCEPTED_RECEIPT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'application/pdf',
];

/**
 * De qual casa e de qual credencial veio o retorno que está sendo aplicado.
 * Ver `PaymentService.filtroDaCasa`.
 */
export interface EscopoDaCasa {
  provider: PaymentProvider;
  configId: string;
  /** A igreja dona da credencial que se autenticou. Ver `filtroDaCasa`. */
  churchId: string;
}

/** Quem pagou, do jeito que a lista de pagamentos do painel mostra */
const SELECT_PESSOA_DO_PAGAMENTO = {
  id: true,
  fullName: true,
  email: true,
  cpf: true,
  profilePhotoUrl: true,
} satisfies Prisma.UserSelect;

/** O que se mostra de um produto comprado: o que é, quanto e por quanto */
const SELECT_ITEM_DE_PRODUTO = {
  id: true,
  quantity: true,
  unitPrice: true,
  variant: {
    select: {
      id: true,
      name: true,
      product: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PaymentProductItemSelect;

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
  ) {}

  private readonly logger = new Logger(PaymentService.name);

  /**
   * Extrato de pagamento é de quem pagou. Fora ele, só o painel — e o
   * `EventTenantGuard` já garantiu que o evento é da igreja de quem pergunta.
   */
  async assertCanSeePayments(requesterId: string, targetUserId: string) {
    if (requesterId === targetUserId) return;

    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { role: true },
    });

    if (!ADMIN_AREA_ROLES.includes(requester?.role as Role)) {
      throw new ForbiddenException(
        'Você só pode ver os seus próprios pagamentos',
      );
    }
  }

  private extrairDddENumero(telefone: string) {
    // Remove tudo que não for número
    const numeros = telefone.replace(/\D/g, '');

    // Remove código do país (55) se existir
    const numeroLimpo = numeros.startsWith('55') ? numeros.slice(2) : numeros;

    if (numeroLimpo.length < 10) {
      throw new Error('Número de telefone inválido');
    }

    const ddd = numeroLimpo.slice(0, 2);
    const numero = numeroLimpo.slice(2);

    return {
      ddd,
      numero,
    };
  }

  /**
   * O módulo de cobrança desta igreja está ligado?
   *
   * Substitui o antigo `PAGBANK_PAYMENT_ENABLED`, que era do servidor inteiro:
   * desligar tirava a cobrança de todas as igrejas de uma vez, e não havia como
   * uma cobrar e a vizinha não. Agora é `Church.modulePayment`.
   *
   * Fica acima da configuração de gateway, e não junto: uma igreja pode ter a
   * casa cadastrada e certa e ainda assim não cobrar, porque o módulo dela está
   * desligado. A ordem importa — conferir a casa primeiro devolveria "nenhuma
   * casa configurada" para quem na verdade está com o módulo fora.
   */
  private exigirModuloDePagamento(church: {
    modulePayment: boolean;
  }) {
    if (!church.modulePayment) {
      // mesma frase do gateway ausente: para quem está do outro lado da tela,
      // módulo desligado e casa sem cadastro são a mesma coisa — esta igreja
      // não recebe pelo site
      throw new ServiceUnavailableException(
        'Esta igreja não recebe pagamento pelo site. O valor é combinado diretamente com a organização do evento.',
      );
    }
  }

  /**
   * A casa que gerou um checkout, e não a que a igreja usa hoje.
   *
   * Trocar de gateway não pode cegar o sistema para o dinheiro que já saiu:
   * perguntar o status de uma cobrança do PagBank com a credencial do Mercado
   * Pago devolve "não existe", e a cobrança paga ficaria parada em WAITING.
   *
   * `configId` nulo é linha anterior a esta coluna — toda ela do PagBank, e é
   * por isso que o `provider` tem default e a busca cai na configuração da
   * igreja.
   */
  private async casaDoCheckout(
    checkout: { configId: string | null; provider: PaymentProvider },
    churchId: string,
  ): Promise<GatewayResolvido> {
    if (checkout.configId) {
      return this.registry.porConfigId(checkout.configId);
    }

    const resolvido = await this.registry.porIgrejaEProvider(
      churchId,
      checkout.provider,
    );

    if (!resolvido) {
      throw new ServiceUnavailableException(
        `A integração ${checkout.provider} não está mais configurada nesta igreja.`,
      );
    }

    return resolvido;
  }

  async createCheckout(dto: CreatePaymentCheckoutDto) {
    const { userId, eventId, roleRegistrationId } = dto;
    const paymentIds = dto.paymentIds ?? [];

    try {
      // ============================
      // FASE 1 — Somente leitura e preparação (SEM TRANSACTION)
      // ============================

      // Verifica se há registros
      if (roleRegistrationId.length === 0 && paymentIds.length === 0) {
        throw new BadRequestException('No role registrations provided');
      }

      // Busca evento — junto do módulo da igreja dona dele, que é quem diz
      // se esta igreja cobra online
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        include: { church: { select: { modulePayment: true } } },
      });
      if (!event) throw new NotFoundException('Event not found');

      this.exigirModuloDePagamento(event.church);

      // Quem cobra é a igreja do evento — é o evento que diz de quem é o
      // dinheiro. Resolver aqui, antes de qualquer escrita, faz a igreja sem
      // gateway configurado parar na porta em vez de no meio da transação.
      const casaDaIgreja = await this.registry.paraIgreja(event.churchId);

      // Busca usuário
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');

      // Busca pagamentos
      const payments = await this.prisma.payment.findMany({
        where: {
          userId,
          eventId,
          // ingressos pela regra; compras avulsas de produto, que não têm
          // regra, pelo id — sempre dentro do mesmo usuário e evento
          OR: [
            { roleRegistrationId: { in: roleRegistrationId } },
            { id: { in: paymentIds } },
          ],
        },
        include: {
          checkouts: true,
          eventUserRole: { select: { role: true, discount: true } },
          productItems: {
            include: {
              variant: {
                select: { name: true, product: { select: { name: true } } },
              },
            },
          },
        },
      });

      if (!payments.length) {
        throw new NotFoundException('No registrations found for payment');
      }

      // estornado é dinheiro devolvido: cobrar de novo seria vender outra vez
      // o que já voltou ao estoque, sem conferir nada
      const aCobrar = payments.filter(
        (p) =>
          p.status !== PaymentStatus.PAID &&
          p.status !== PaymentStatus.REFUNDED,
      );

      if (!aCobrar.length) {
        throw new BadRequestException(
          payments.some((p) => p.status === PaymentStatus.REFUNDED)
            ? 'Pagamento estornado não pode ser pago de novo. Fale com a organização do evento.'
            : 'Alguns itens possuem pagamentos em andamento. Por favor, atualize a página.',
        );
      }

      /**
       * Compra cancelada devolveu as unidades: pagar de novo é pegá-las outra
       * vez. Conferir e voltar para "aguardando" é uma coisa só, serializável
       * — a compra nova lê o estoque do mesmo jeito, e das duas que disputam
       * a última unidade só uma grava. Antes do gateway, para não abrir
       * cobrança do que esgotou.
       */
      const reativacao = await emTransacaoSerializavel(
        this.prisma,
        async (tx) => {
          const resultado = await reativarCompras(
            tx,
            aCobrar.map((p) => p.id),
          );
          await tx.payment.updateMany({
            where: { id: { in: resultado.reativados } },
            data: {
              status: PaymentStatus.WAITING,
              method: PaymentMethod.OTHER,
            },
          });
          return resultado;
        },
      );

      const itensForaDoEstoque = new Set(reativacao.itensRemovidos);
      const unpaidPayments = aCobrar
        .filter(
          (p) =>
            !STATUS_QUE_LIBERAM_ESTOQUE.includes(p.status) ||
            reativacao.reativados.includes(p.id),
        )
        .map((p) => ({
          ...p,
          productItems: p.productItems.filter(
            (item) => !itensForaDoEstoque.has(item.id),
          ),
        }));

      if (!unpaidPayments.length) {
        throw new BadRequestException(reativacao.recusa);
      }

      const activeCheckouts = unpaidPayments
        .flatMap((p) => p.checkouts)
        .filter((c) => c.status === CheckoutStatus.ACTIVE);

      // se o pagamento tiver checkouts criados e ativos deve ferificar se eles estão ativos na api também
      //caso algum checkout tive status difererente de awainting na api, deve atualizar o status no banco e cancelalr a operação
      if (activeCheckouts.length > 0) {
        for (const checkout of activeCheckouts) {
          try {
            const casa = await this.casaDoCheckout(checkout, event.churchId);
            const charges = await casa.gateway.listCharges(
              checkout.referenceId,
              casa.context,
            );

            // Lista vazia é o mesmo caso do "não encontrado": o checkout saiu
            // daqui e nunca virou cobrança lá. O `reduce` sem valor inicial
            // estoura em lista vazia, e estourar aqui derrubaria a criação do
            // checkout novo por causa de um que nem existe.
            if (charges.length === 0) continue;

            const chargeMaisRecente = charges.reduce((atual, item) =>
              item.createdAt > atual.createdAt ? item : atual,
            );

            const statusConferido = conferirValorPago(
              chargeMaisRecente.status,
              chargeMaisRecente.paidAmountCents,
              checkout.chargedAmountCents,
              checkout.referenceId,
            );

            if (statusConferido !== PaymentStatus.WAITING) {
              //atualiza no banco
              await this.prisma.paymentCheckout.updateMany({
                where: { checkoutId: checkout.checkoutId },
                data: { status: CheckoutStatus.INACTIVE },
              });
              await this.prisma.payment.updateMany({
                where: { id: checkout.paymentId },
                data: {
                  status: statusConferido,
                  method: chargeMaisRecente.method,
                  payload: chargeMaisRecente.payload as Prisma.InputJsonValue,
                  // mesma regra do retorno: o dado é do gateway
                  receivedFrom: PaymentReceived.SYSTEM,
                },
              });
              throw new BadRequestException(
                `Alguns itens possuem pagamentos em andamento. Por favor, atualize a página.`,
              );
            }
          } catch (error) {
            if (error instanceof GatewayResourceNotFoundError) {
              // mesmo com checkout ativo, nenhuma ordem foi criada na casa,
              // então pode prosseguir
              continue;
            }
            this.logger.error(
              `Erro ao verificar status do pagamento em ${checkout.provider} para referenceId ${checkout.referenceId}:`,
              error,
            );
            throw error;
          }
        }
      }

      // ---------- regra de reutilização ----------
      const allHaveActive = unpaidPayments.every((p) =>
        p.checkouts?.some((c) => c.status === CheckoutStatus.ACTIVE),
      );

      let reuseCheckout = false;
      let reuseLink = '';

      // Reutilização de checkout
      if (allHaveActive && activeCheckouts.length > 0) {
        const uniqueIds = new Set(activeCheckouts.map((c) => c.checkoutId));

        if (uniqueIds.size === 1) {
          const checkoutId = [...uniqueIds][0];

          const usedByOthers = await this.prisma.paymentCheckout.findMany({
            where: {
              checkoutId,
              status: CheckoutStatus.ACTIVE,
              payment: {
                NOT: { id: { in: unpaidPayments.map((p) => p.id) } },
              },
            },
          });

          // Verifica se esse checkout já está a mais de 1h aberto
          const checkoutCreatedAt = activeCheckouts[0].createdAt || new Date();
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

          if (usedByOthers.length === 0 && checkoutCreatedAt > oneHourAgo) {
            // Atualiza pagamentos para WAITING
            await this.prisma.payment.updateMany({
              where: {
                id: { in: unpaidPayments.map((p) => p.id) },
              },
              data: {
                status: PaymentStatus.WAITING,
                method: PaymentMethod.OTHER,
              },
            });

            reuseCheckout = true;
            reuseLink = activeCheckouts[0].link;
          }
        }
      }

      // ============================
      // Reutilização imediata
      // ============================
      if (reuseCheckout) {
        return {
          message: 'Checkout already exists',
          link: reuseLink,
        };
      }

      // ---------- prepara dados para novo checkout ----------
      // só pagamento com ingresso vira item de ingresso: a compra avulsa de
      // produto não tem regra, e viraria um "Ingresso" de R$ 0
      const tickets = unpaidPayments
        .filter((p) => p.eventUserRole?.role)
        .map((p) => {
          const role = p.eventUserRole?.role;
          return {
            id: role?.id ?? 'unknown',
            description: role?.description ?? 'Ingresso',
            price: role?.price ?? 0,
          };
        });

      // Calcula desconto
      const totalDiscount = unpaidPayments.reduce((acc, payment) => {
        const discount = payment.eventUserRole?.discount;
        if (discount) {
          return (
            acc +
            discount.percentage * (payment.eventUserRole?.role?.price || 0)
          );
        }
        return acc;
      }, 0);

      /**
       * Os produtos: os que foram junto do ingresso e as compras avulsas, com
       * o preço gravado no momento da compra — não o de agora, que o admin
       * pode ter mudado depois.
       *
       * O desconto continua sendo só do ingresso (`totalDiscount` lê o preço
       * da regra). Nas casas sem campo de desconto ele é espalhado entre todos
       * os itens por `aplicarDesconto`, mas o total abatido é o mesmo.
       */
      const produtos = unpaidPayments.flatMap((p) =>
        p.productItems.map((item) => ({
          referenceId: item.variantId,
          description: `${item.variant.product.name} - ${item.variant.name}`,
          name: `${item.variant.product.name} (${item.variant.name})`,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      );
      const totalDosProdutos = produtos.reduce(
        (soma, produto) => soma + produto.unitPrice * produto.quantity,
        0,
      );

      if (!tickets.length && !produtos.length) {
        throw new BadRequestException('No tickets found for payment');
      }

      const { ddd, numero } = this.extrairDddENumero(user.cellphone);
      const dateExpiration = new Date(Date.now() + 1 * 60 * 60 * 1000); //1h
      const frontendUrl = process.env.URL_FRONTEND?.replace(/\/$/, '');

      // A URL de notificação carrega o segredo desta igreja nesta casa. Cada
      // igreja tem o seu: um vazamento não vale para as outras, e a rota
      // reconhece qual configuração está respondendo sem confiar no corpo.
      const { gateway, context, config, webhookSecret } = casaDaIgreja;

      const pedido: HostedCheckoutRequest = {
        referenceId: randomUUID(),
        eventId,
        eventName: event.name,
        softDescriptor: 'Igreja de cristo',
        expiresAt: dateExpiration,
        paymentNotificationUrl: montarUrlDeWebhook(
          config.provider,
          webhookSecret,
          CANAL_DE_PAGAMENTO,
        ),
        checkoutNotificationUrl: montarUrlDeWebhook(
          config.provider,
          webhookSecret,
          CANAL_DE_CHECKOUT,
        ),
        redirectUrl: `${frontendUrl}/events/${eventId}`,
        customer: {
          name: user.fullName,
          email: user.email,
          taxId: user.cpf,
          phone: { country: '55', area: ddd, number: numero },
        },
        // Arredondado: o desconto é percentual sobre o preço, e um resultado
        // como 1234.9999999 em centavos é recusado por casa que só aceita
        // inteiro — e aceito como fração por quem converte na marra.
        discountCents: Math.round(totalDiscount * 100),
        items: [
          ...tickets
            .filter((t) => t.price > 0)
            .map((t) => ({
              referenceId: t.id,
              description: t.description,
              name: `Ingresso ${event.name} - ${t.description}`,
              quantity: 1,
              unitAmountCents: Math.round(t.price * 100),
            })),
          ...produtos
            .filter((produto) => produto.unitPrice > 0)
            .map((produto) => ({
              referenceId: produto.referenceId,
              description: produto.description,
              name: produto.name,
              quantity: produto.quantity,
              unitAmountCents: Math.round(produto.unitPrice * 100),
            })),
        ],
      };

      const checkoutIdsToInvalidate = [
        ...new Set(activeCheckouts.map((c) => c.checkoutId)),
      ];

      // ============================
      // FASE 2 — Chamada externa (fora da transaction)
      // ============================
      const result = await gateway.createCheckout(pedido, context);

      const linkPay = result.payUrl;

      if (!linkPay) {
        throw new BadRequestException(
          `Não foi possível gerar o link de pagamento em ${gateway.descriptor.label}`,
        );
      }

      // Invalidar checkouts antigos na api (assíncrono).
      // Cada um na casa que o criou: um checkout do PagBank não se invalida
      // com a credencial do Mercado Pago.
      const antigosPorId = new Map(
        activeCheckouts.map((c) => [c.checkoutId, c]),
      );

      for (const checkoutId of checkoutIdsToInvalidate) {
        const antigo = antigosPorId.get(checkoutId);
        if (!antigo) continue;

        this.casaDoCheckout(antigo, event.churchId)
          .then((casa) =>
            casa.gateway.inactivateCheckout(checkoutId, casa.context),
          )
          .catch((err) => {
            this.logger.error(
              `Erro ao inativar checkout ${checkoutId} em ${antigo.provider}:`,
              JSON.stringify(err?.message ?? err),
            );
          });
      }

      // ============================
      // FASE 3 — Agora sim: grava tudo de uma vez (COM TRANSACTION MANTIDA)
      // ============================
      await this.prisma.$transaction(
        async (tx) => {
          // 1. Inativa todos os checkouts antigos envolvidos
          if (checkoutIdsToInvalidate.length > 0) {
            await tx.paymentCheckout.updateMany({
              where: {
                checkoutId: { in: checkoutIdsToInvalidate },
                status: CheckoutStatus.ACTIVE,
              },
              data: { status: CheckoutStatus.INACTIVE },
            });
          }

          // 2. Cria os novos vínculos
          await tx.paymentCheckout.createMany({
            data: unpaidPayments.map((payment) => ({
              paymentId: payment.id,
              checkoutId: result.checkoutId,
              link: linkPay,
              referenceId: pedido.referenceId,
              status: CheckoutStatus.ACTIVE,
              // ingressos + produtos, sem desconto — o mesmo que os
              // pagamentos somam em `amount`
              amount:
                tickets.reduce((sum, t) => sum + t.price, 0) + totalDosProdutos,
              // O que a casa foi mandada cobrar, já com o desconto. `amount`
              // fica como está — soma dos ingressos, em reais, sem desconto —
              // porque é o que os relatórios leem; a baixa precisa do outro
              // número para conferir o que voltou pago.
              chargedAmountCents: totalCobradoEmCentavos(
                pedido.items,
                pedido.discountCents,
              ),
              // De quem é este checkout. Sem os dois, o retorno da casa e a
              // reconciliação teriam que adivinhar a quem perguntar.
              provider: config.provider,
              configId: config.id,
            })),
          });

          // 3. Mudar os status dos pagamentos para WAITING
          await tx.payment.updateMany({
            where: {
              id: { in: unpaidPayments.map((p) => p.id) },
            },
            data: {
              status: PaymentStatus.WAITING,
              method: PaymentMethod.OTHER,
            },
          });
        },
        {
          timeout: 20000, // 20 segundos
          maxWait: 5000, // tempo máximo esperando conexão
        },
      );

      return {
        message: 'checkout created',
        link: linkPay,
      };
    } catch (error) {
      console.log(error);
      throw error;
    }
  }

  /**
   * Recorte do retorno: a casa que se autenticou só mexe no que é dela.
   *
   * A referência é um uuid nosso e não se adivinha, mas isto não custa nada e
   * fecha o caso em que ela é conhecida: uma notificação autenticada pela
   * credencial de uma igreja não dá baixa em cobrança de outra.
   *
   * O ramo de `configId: null` é o histórico — checkouts anteriores à coluna,
   * todos do PagBank.
   */
  private filtroDaCasa(escopo?: EscopoDaCasa) {
    if (!escopo) return {};

    return {
      OR: [
        { configId: escopo.configId },
        /**
         * Checkout anterior à coluna `configId` — todos do PagBank. Aqui não
         * há credencial gravada para comparar, então o recorte tem que vir da
         * igreja dona do evento.
         *
         * Sem ela, a casa bastava: um admin que configura o PagBank da sua
         * igreja tem token e segredo de URL, e com eles assinaria um "pago"
         * para a referência antiga de qualquer outra igreja. O uuid da
         * referência não sai em resposta nenhuma e é o que segurava isso — mas
         * segredo por obscuridade não é recorte.
         */
        {
          configId: null,
          provider: escopo.provider,
          payment: {
            eventUserRole: {
              eventOnUsers: { event: { churchId: escopo.churchId } },
            },
          },
        },
      ],
    };
  }

  async updatePaymentWebhook(
    referenceId: string,
    status: PaymentStatus,
    method: PaymentMethod,
    payload: any,
    escopo?: EscopoDaCasa,
    pagoEmCentavos?: number | null,
  ) {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const paymentCheckout = await tx.paymentCheckout.findMany({
            where: { referenceId, ...this.filtroDaCasa(escopo) },
            include: { payment: true },
          });
          if (!paymentCheckout || paymentCheckout.length === 0) {
            throw new NotFoundException('Payment not found');
          }
          if (paymentCheckout[0].payment.status === PaymentStatus.PAID) {
            return; // idempotência
          }

          // "Pago" só vale se o valor bate com o que foi cobrado
          const statusConferido = conferirValorPago(
            status,
            pagoEmCentavos,
            paymentCheckout[0].chargedAmountCents,
            referenceId,
          );

          // marcar como recebido
          //
          // `tx`, e não `this.prisma`: com o cliente de fora, estas duas
          // escritas rodavam soltas, cada uma se confirmando por conta
          // própria. A leitura acima continuava valendo dentro da transação e
          // as escritas, fora — então o `return` de idempotência protegia
          // contra reenvio, mas nada protegia contra falha no meio: um erro
          // entre uma e outra deixava o pagamento marcado como pago com o
          // checkout ainda ativo, e o próximo clique em "pagar" reabria a
          // cobrança de quem já tinha pagado.
          await tx.payment.updateMany({
            where: { id: { in: paymentCheckout.map((pc) => pc.payment.id) } },
            data: {
              method,
              status: statusConferido,
              payload,
              // é aqui que a cobrança ganha origem: o dado veio do gateway, e
              // a partir de agora quem manda no status é ele, não a tela
              receivedFrom: PaymentReceived.SYSTEM,
            },
          });
          /**
           * O checkout fecha quando o dinheiro entra — e só então.
           *
           * Antes fechava em qualquer notificação, o que era inofensivo
           * enquanto só o retorno de "pago" chegava aqui. Com o aviso de
           * pedido criado também sendo aplicado, fechar nele derrubava o
           * checkout de um Pix que ainda nem tinha sido pago: o próximo
           * clique em "pagar" abriria uma segunda cobrança para a mesma
           * inscrição, e quem pagasse as duas pagaria duas vezes.
           *
           * O retorno de "pago" continua achando a cobrança pelo
           * `referenceId`, esteja o checkout ativo ou não.
           */
          if (statusConferido === PaymentStatus.PAID) {
            await tx.paymentCheckout.updateMany({
              where: { referenceId, ...this.filtroDaCasa(escopo) },
              data: { status: CheckoutStatus.INACTIVE },
            });
          }
        },
        {
          timeout: 20000, // 20 segundos
          maxWait: 10000, // tempo máximo esperando conexão
        },
      );
      return { message: 'Webhook de pagamento atualizado com sucesso' };
    } catch (error) {
      console.log('Erro ao atualizar webhook de pagamento:', error);
    }
  }
  async updatePaymentCheckoutWebhook(
    checkoutId: string,
    status: CheckoutStatus,
    escopo?: EscopoDaCasa,
  ) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const paymentCheckout = await tx.paymentCheckout.findMany({
          where: { checkoutId, ...this.filtroDaCasa(escopo) },
        });
        if (!paymentCheckout || paymentCheckout.length === 0) {
          throw new NotFoundException('Payment checkout not found');
        }
        await tx.paymentCheckout.updateMany({
          where: { checkoutId, ...this.filtroDaCasa(escopo) },
          data: { status },
        });
      });
      return { message: 'Webhook de checkout atualizado com sucesso' };
    } catch (error) {
      console.log('Erro ao atualizar webhook de checkout:', error);
    }
  }

  /**
   * @param paymentId vem do caminho da rota, nunca do corpo — ver o DTO.
   */
  async updatePaymentStatus(
    paymentId: string,
    payload: UpdatePaymentStatusDto,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        eventUserRole: {
          include: {
            eventOnUsers: {
              include: { event: { select: { id: true, name: true } } },
            },
          },
        },
      },
    });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }
    if (
      payment.status === PaymentStatus.PAID &&
      payload.status !== PaymentStatus.REFUNDED
    ) {
      throw new BadRequestException(
        'Não é possível alterar um pagamento já pago, exceto para reembolso',
      );
    }
    // compra avulsa de produto não tem inscrição: o evento vem do pagamento
    const eventId =
      payment.eventUserRole?.eventOnUsers?.event?.id ?? payment.eventId;
    let url: string | undefined;
    let fileType: string | undefined;
    if (payload.receiptFile) {
      // O front filtra, mas o `accept` do input não é garantia nenhuma — já
      // chegou aqui .txt de drag-and-drop do app Fotos, que virou comprovante
      // "enviado" e não abre em lugar nenhum.
      if (!ACCEPTED_RECEIPT_MIME_TYPES.includes(payload.receiptFile.mimetype)) {
        throw new BadRequestException(
          'O comprovante precisa ser PNG, JPG ou PDF',
        );
      }
      fileType = payload.receiptFile.mimetype;
      url = (
        await uploadImageFirebase(
          payload.receiptFile,
          `events/${eventId}/payments/receipt-${
            paymentId
          }-${Date.now()}`,
        )
      ).url;
    }

    // tirar do cancelado ou do estornado devolve os produtos à compra: a
    // conferência do estoque e o status novo vão juntos, como no checkout
    await emTransacaoSerializavel(this.prisma, async (tx) => {
      if (!STATUS_QUE_LIBERAM_ESTOQUE.includes(payload.status)) {
        const { reativados, recusa } = await reativarCompras(tx, [paymentId]);
        if (recusa && !reativados.length) {
          throw new BadRequestException(recusa);
        }
      }

      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: payload.status,
          method: payload.method,
          // só quando a mão de alguém trouxe o dinheiro; ver `ehLancamentoManual`
          ...(ehLancamentoManual(payment.status, payload.status) && {
            receivedFrom: PaymentReceived.EXTERNAL,
          }),
          // desconto é da inscrição; compra avulsa de produto não tem onde
          // guardar, e o update aninhado estouraria sem a relação
          ...(payload.discountsAppliedId &&
            payment.roleRegistrationId && {
              eventUserRole: {
                update: {
                  discountId: payload?.discountsAppliedId || null,
                },
              },
            }),
          payload: {
            ...(typeof payment.payload === 'object' && payment.payload !== null
              ? payment.payload
              : {}),
            // Só sobrescreve quando veio arquivo novo: `comprovanteFileUrl:
            // undefined` some na serialização do Json e apagaria o comprovante
            // já enviado em qualquer edição posterior (o reembolso, por ex.).
            // o tipo fica salvo para o front saber renderizar sem chutar: a url
            // gerada no upload não tem extensão
            ...(url && {
              comprovanteFileUrl: url,
              comprovanteFileType: fileType,
            }),
          },
        },
      });
    });
    // ivalidar os checkouts que contem esse pagamento em todos os pagamentos relacionados
    await this.prisma.$transaction(async (tx) => {
      const activeCheckouts = await tx.paymentCheckout.findMany({
        where: {
          paymentId: paymentId,
          status: CheckoutStatus.ACTIVE,
        },
      });

      const checkoutIdsToInvalidate = [
        ...new Set(activeCheckouts.map((c) => c.checkoutId)),
      ];

      if (checkoutIdsToInvalidate.length > 0) {
        await tx.paymentCheckout.updateMany({
          where: {
            checkoutId: { in: checkoutIdsToInvalidate },
            status: CheckoutStatus.ACTIVE,
          },
          data: { status: CheckoutStatus.INACTIVE },
        });
      }
    });

    // await this.prisma.paymentCheckout.updateMany({
    //   where: {
    //     paymentId: paymentId,
    //     status: CheckoutStatus.ACTIVE,
    //   },
    //   data: { status: CheckoutStatus.INACTIVE },
    // });
  }

  /**
   * A trilha do dinheiro do evento: quem mexeu, no quê e vindo de onde.
   *
   * Vem de `payment_logs`, e não de `logs`: lá cada mudança é um retrato em
   * JSON de uma tabela: aqui a linha já traz valor, status e origem, que é o
   * que se lê para entender por que uma cobrança está como está.
   *
   * Os nomes são resolvidos numa consulta só para a página inteira. O da
   * pessoa vem do cadastro atual; quando o cadastro sumiu, a linha continua
   * valendo pelo valor e pelo status — o histórico do dinheiro não depende de
   * o inscrito ainda existir.
   */
  async findPaymentLogs(eventId: string, query: ListPaymentLogsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const where: Prisma.PaymentLogWhereInput = {
      eventId,
      ...(query.paymentId && { paymentId: query.paymentId }),
      ...(query.userId && { userId: query.userId }),
      ...(query.source && { source: query.source }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };

    const [linhas, total] = await Promise.all([
      this.prisma.paymentLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.paymentLog.count({ where }),
    ]);

    const pessoas = await this.nomesDasPessoas(linhas);

    return {
      items: linhas.map((linha) => ({
        ...linha,
        /** quem deve; nulo quando a linha não é sobre uma pessoa */
        userName: linha.userId ? pessoas.get(linha.userId) ?? null : null,
        /** quem executou; nulo no cron e no retorno do gateway */
        actorName: linha.actorId ? pessoas.get(linha.actorId) ?? null : null,
      })),
      total,
      page,
      limit,
    };
  }

  /** Uma consulta para a página inteira: quem deve e quem executou, juntos */
  private async nomesDasPessoas(
    linhas: { userId: string | null; actorId: string | null }[],
  ) {
    const ids = new Set<string>();
    linhas.forEach((linha) => {
      if (linha.userId) ids.add(linha.userId);
      if (linha.actorId) ids.add(linha.actorId);
    });

    if (ids.size === 0) return new Map<string, string>();

    const pessoas = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, fullName: true },
    });

    return new Map(pessoas.map((p) => [p.id, p.fullName.trim()]));
  }

  /**
   * Uma linha por pagamento: cada inscrição (com os produtos que foram junto)
   * e cada compra avulsa de produto.
   *
   * `purchaseType` diz qual é qual. A compra avulsa não tem grupo nem regra,
   * e é por ele que o painel a separa numa aba própria.
   */
  async findPaymentsByEvent(eventId?: string, userId?: string) {
    const [inscricoes, comprasAvulsas] = await Promise.all([
      this.prisma.eventOnUsers.findMany({
        where: {
          ...(eventId && { eventId }),
          ...(userId && { userId }),
        },
        include: {
          rolesRegistration: {
            select: {
              discount: { select: { id: true } },
              payment: {
                include: {
                  // quem compra o quê: é por aqui que a organização separa
                  // as camisas de cada um na entrega
                  productItems: { select: SELECT_ITEM_DE_PRODUTO },
                },
              },
              role: {
                select: {
                  groupId: true,
                  description: true,
                  group: { select: { name: true } },
                },
              },
            },
          },

          user: {
            select: SELECT_PESSOA_DO_PAGAMENTO,
          }, // se não tiver eventid, traz os dados do evento tb
          event: eventId
            ? false
            : {
                select: {
                  id: true,
                  name: true,
                  data: true,
                },
              },
        },
      }),
      this.prisma.payment.findMany({
        where: {
          ...(eventId && { eventId }),
          ...(userId && { userId }),
          roleRegistrationId: null,
          productItems: { some: {} },
        },
        include: { productItems: { select: SELECT_ITEM_DE_PRODUTO } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const linhasDeInscricao = inscricoes.flatMap((eou) =>
      eou.rolesRegistration
        .filter((rr) => rr.payment) // evita null
        .map((rr) => ({
          ...eou.user,
          ...rr.payment, // cada pagamento vira um item separado
          purchaseType: 'REGISTRATION' as const,
          groupId: rr.role?.groupId,
          groupName: rr.role?.group?.name,
          roleName: rr.role?.description,
          discountsAppliedId: rr.discount?.id,
        })),
    );

    if (!comprasAvulsas.length) return linhasDeInscricao;

    // o pagamento guarda só o id da pessoa: os dados dela vêm numa consulta
    // só, para a página inteira
    const pessoas = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(comprasAvulsas.map((p) => p.userId!))] } },
      select: SELECT_PESSOA_DO_PAGAMENTO,
    });
    const pessoaPorId = new Map(pessoas.map((pessoa) => [pessoa.id, pessoa]));

    const linhasAvulsas = comprasAvulsas.map((compra) => ({
      ...pessoaPorId.get(compra.userId!),
      ...compra,
      purchaseType: 'PRODUCTS' as const,
    }));

    return [...linhasDeInscricao, ...linhasAvulsas];
  }

  async findPaymentsByUser(userId: string, eventId?: string) {
    return this.prisma.payment.findMany({
      where: {
        userId,
        ...(eventId && { eventId }),
      },
      include: {
        checkouts: true,
        eventUserRole: {
          include: {
            role: true,
            eventOnUsers: {
              include: {
                event: true,
              },
            },
          },
        },
      },
    });
  }

  async refundPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Only PAID payments can be refunded');
    }

    return this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: PaymentStatus.REFUNDED,
      },
    });
  }
  /**
   * Registra (ou desfaz) a entrega dos produtos de uma compra.
   *
   * A entrega é da compra inteira: quem leva duas camisas paga uma vez e
   * recebe as duas de uma vez.
   *
   * Só compra paga pode ser entregue — entregar antes de receber é justamente
   * o que o controle existe para impedir. Desfazer, ao contrário, vale em
   * qualquer status: é a correção de um registro errado, e quando um pagamento
   * é estornado a entrega precisa poder voltar atrás.
   */
  async updateProductsDelivery(
    paymentId: string,
    delivered: boolean,
    adminId?: string,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        _count: { select: { productItems: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException('Pagamento não encontrado');
    }

    if (payment._count.productItems === 0) {
      throw new BadRequestException(
        'Esta compra não tem produtos para entregar',
      );
    }

    if (delivered && payment.status !== PaymentStatus.PAID) {
      throw new BadRequestException(
        'Só dá para registrar a entrega depois que o pagamento estiver pago',
      );
    }

    return this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        productsDeliveredAt: delivered ? new Date() : null,
        productsDeliveredById: delivered ? adminId ?? null : null,
      },
      select: {
        id: true,
        productsDeliveredAt: true,
        productsDeliveredById: true,
      },
    });
  }

  /**
   * @param requesterId quem pediu o extrato. O admin de uma igreja não pode
   * ver o que a pessoa deve nas outras: sem este recorte bastava o id de um
   * inscrito para ler a vida financeira dele no sistema inteiro.
   */
  async findUserEventsWithRoles(userId: string, requesterId?: string) {
    const requester = requesterId
      ? await this.prisma.user.findUnique({
          where: { id: requesterId },
          select: SELECT_TENANT,
        })
      : null;

    // a própria pessoa vê tudo o que é dela; o painel vê só as igrejas dele
    const churchIds =
      requesterId === userId ? null : tenantChurchIds(requester);

    /**
     * Com a loja pública, dá para comprar sem estar inscrito — e a compra
     * precisa aparecer aqui, senão a pessoa não teria por onde pagá-la. O
     * pagamento não tem relação com o evento no schema, por isso os ids vêm
     * numa consulta à parte.
     */
    const eventosComCompraAvulsa = (
      await this.prisma.payment.findMany({
        where: { userId, roleRegistrationId: null, productItems: { some: {} } },
        select: { eventId: true },
        distinct: ['eventId'],
      })
    )
      .map((pagamento) => pagamento.eventId)
      .filter((id): id is string => !!id);

    const events = await this.prisma.event.findMany({
      where: {
        ...(churchIds ? { churchId: { in: churchIds } } : {}),
        OR: [
          {
            users: {
              some: {
                userId,
                rolesRegistration: { some: {} },
              },
            },
          },
          {
            waitlist: {
              some: {
                userId,
                roleRegistrationId: { not: null },
              },
            },
          },
          ...(eventosComCompraAvulsa.length
            ? [{ id: { in: eventosComCompraAvulsa } }]
            : []),
        ],
      },
      select: {
        id: true,
        name: true,
        data: true,
        // O módulo da igreja dona do evento: é ele que decide se a tela mostra
        // ou esconde tudo que fala de pagamento neste cartão. Sem vir daqui, a
        // tela teria que perguntar igreja por igreja para montar a lista.
        church: { select: { modulePayment: true } },

        users: {
          where: { userId },
          select: {
            minorApprovalStatus: true,
            signedTermUrl: true,
            minorApprovalRejectionReason: true,
            rolesRegistration: {
              select: {
                role: {
                  select: {
                    id: true,
                    description: true,
                    price: true,
                    group: { select: { name: true } },
                  },
                },
                payment: {
                  select: {
                    status: true,
                    method: true,
                    productItems: { select: SELECT_ITEM_DE_PRODUTO },
                  },
                },
              },
            },
          },
        },

        waitlist: {
          where: {
            userId,
            roleRegistrationId: { not: null },
          },
          select: {
            rolesRegistration: {
              select: {
                id: true,
                description: true,
                price: true,
                group: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    // compras avulsas de produto: não passam pela inscrição, então não vêm no
    // `select` acima
    const comprasAvulsas = events.length
      ? await this.prisma.payment.findMany({
          where: {
            userId,
            eventId: { in: events.map((event) => event.id) },
            roleRegistrationId: null,
            productItems: { some: {} },
          },
          select: {
            id: true,
            eventId: true,
            status: true,
            method: true,
            amount: true,
            createdAt: true,
            productItems: { select: SELECT_ITEM_DE_PRODUTO },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];

    return events.map((event) => ({
      eventId: event.id,
      eventName: event.name,
      data: event.data,
      modulePayment: event.church.modulePayment,

      /** 🔹 Liberação de menor de idade — NOT_REQUIRED quando não há inscrição do usuário neste evento */
      minorApprovalStatus:
        event.users[0]?.minorApprovalStatus ?? 'NOT_REQUIRED',
      signedTermUrl: event.users[0]?.signedTermUrl ?? null,
      minorApprovalRejectionReason:
        event.users[0]?.minorApprovalRejectionReason ?? null,

      registeredRoles: event.users.flatMap((u) =>
        u.rolesRegistration.map((r) => ({
          roleId: r.role.id,
          description: r.role.description,
          group: r.role.group.name,
          price: r.role.price,
          paymentStatus: r.payment?.status ?? 'WAITING',
          paymentMethod: r.payment?.method ?? null,
          products: r.payment?.productItems ?? [],
        })),
      ),

      productPurchases: comprasAvulsas
        .filter((compra) => compra.eventId === event.id)
        .map(({ eventId: _evento, ...compra }) => compra),

      waitlistRoles: event.waitlist.map((w) => ({
        roleId: w.rolesRegistration!.id,
        description: w.rolesRegistration!.description,
        group: w.rolesRegistration!.group.name,
        price: w.rolesRegistration!.price,
      })),
    }));
  }

  //gambis
  async getDiscounts() {
    const data = await this.prisma.discounts.findMany();
    return data.map((d) => ({
      id: d.id,
      description: d.description,
      percentage: d.percentage,
    }));
  }
}
