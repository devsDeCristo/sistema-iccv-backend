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
   * Interruptor geral, acima da configuração de cada igreja.
   *
   * Existia como `PAGBANK_PAYMENT_ENABLED` e continua valendo pelo nome antigo:
   * é o que se desliga quando o problema é do sistema e não de uma igreja. A
   * lógica inverteu — antes era preciso ligar explicitamente, agora é preciso
   * desligar —, e não afrouxa nada: sem casa cadastrada e ligada, a igreja
   * continua sem cobrar, que é o que a ausência da variável significava.
   */
  private exigirPagamentoOnlineLigado() {
    const desligado =
      process.env.ONLINE_PAYMENT_ENABLED === 'false' ||
      process.env.PAGBANK_PAYMENT_ENABLED === 'false';

    if (desligado) {
      throw new ServiceUnavailableException(
        'Pagamentos online estão temporariamente indisponíveis. Contate o suporte!',
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
    this.exigirPagamentoOnlineLigado();

    const { userId, eventId, roleRegistrationId } = dto;

    try {
      // ============================
      // FASE 1 — Somente leitura e preparação (SEM TRANSACTION)
      // ============================

      // Verifica se há registros
      if (roleRegistrationId.length === 0) {
        throw new BadRequestException('No role registrations provided');
      }

      // Busca evento
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
      });
      if (!event) throw new NotFoundException('Event not found');

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
          roleRegistrationId: { in: roleRegistrationId },
        },
        include: {
          checkouts: true,
          eventUserRole: { select: { role: true, discount: true } },
        },
      });

      if (!payments.length) {
        throw new NotFoundException('No registrations found for payment');
      }

      const unpaidPayments = payments.filter(
        (p) => p.status !== PaymentStatus.PAID,
      );

      if (!unpaidPayments.length) {
        throw new BadRequestException(
          'Alguns itens possuem pagamentos em andamento. Por favor, atualize a página.',
        );
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
                  payload: chargeMaisRecente.raw as Prisma.InputJsonValue,
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
      const tickets = unpaidPayments.map((p) => {
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

      if (!tickets.length) {
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
        items: tickets
          .filter((t) => t.price > 0)
          .map((t) => ({
            referenceId: t.id,
            description: t.description,
            name: `Ingresso ${event.name} - ${t.description}`,
            quantity: 1,
            unitAmountCents: Math.round(t.price * 100),
          })),
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
              amount: tickets.reduce((sum, t) => sum + t.price, 0),
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
          await this.prisma.payment.updateMany({
            where: { id: { in: paymentCheckout.map((pc) => pc.payment.id) } },
            data: {
              method,
              status: statusConferido,
              payload,
            },
          });
          // inativar checkouts
          await this.prisma.paymentCheckout.updateMany({
            where: { referenceId },
            data: { status: CheckoutStatus.INACTIVE },
          });
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

  async updatePaymentStatus(payload: UpdatePaymentStatusDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: payload.paymentId },
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
    const eventId = payment.eventUserRole?.eventOnUsers?.event?.id;
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
            payload.paymentId
          }-${Date.now()}`,
        )
      ).url;
    }

    await this.prisma.payment.update({
      where: { id: payload.paymentId },
      data: {
        status: payload.status,
        method: payload.method,
        // só quando a mão de alguém trouxe o dinheiro; ver `ehLancamentoManual`
        ...(ehLancamentoManual(payment.status, payload.status) && {
          receivedFrom: PaymentReceived.EXTERNAL,
        }),
        ...(payload.discountsAppliedId && {
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
    // ivalidar os checkouts que contem esse pagamento em todos os pagamentos relacionados
    await this.prisma.$transaction(async (tx) => {
      const activeCheckouts = await tx.paymentCheckout.findMany({
        where: {
          paymentId: payload.paymentId,
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
    //     paymentId: payload.paymentId,
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

  async findPaymentsByEvent(eventId?: string, userId?: string) {
    return this.prisma.eventOnUsers
      .findMany({
        where: {
          ...(eventId && { eventId }),
          ...(userId && { userId }),
        },
        include: {
          rolesRegistration: {
            select: {
              discount: { select: { id: true } },
              payment: true,
              role: {
                select: { groupId: true, group: { select: { name: true } } },
              },
            },
          },

          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              cpf: true,
              profilePhotoUrl: true,
            },
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
      })
      .then((eventOnUsers) => {
        return eventOnUsers.flatMap((eou) =>
          eou.rolesRegistration
            .filter((rr) => rr.payment) // evita null
            .map((rr) => ({
              ...eou.user,
              ...rr.payment, // cada pagamento vira um item separado
              groupId: rr.role?.groupId,
              groupName: rr.role?.group?.name,
              discountsAppliedId: rr.discount?.id,
            })),
        );
      });
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
        ],
      },
      select: {
        id: true,
        name: true,
        data: true,

        users: {
          where: { userId },
          select: {
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

    return events.map((event) => ({
      eventId: event.id,
      eventName: event.name,
      data: event.data,

      registeredRoles: event.users.flatMap((u) =>
        u.rolesRegistration.map((r) => ({
          roleId: r.role.id,
          description: r.role.description,
          group: r.role.group.name,
          price: r.role.price,
          paymentStatus: r.payment?.status ?? 'WAITING',
          paymentMethod: r.payment?.method ?? null,
        })),
      ),

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
