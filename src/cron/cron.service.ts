import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CheckoutStatus, PaymentProvider, PaymentStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma';
import { runAsJob } from 'src/context/request.context';
import {
  GatewayResolvido,
  PaymentGatewayRegistry,
} from 'src/gateways/core/payment-gateway.registry';
import { GatewayResourceNotFoundError } from 'src/gateways/core/gateway.errors';
import { conferirValorPago } from 'src/payment/amount-check';

/** Uma cobrança pendente e a casa a quem perguntar por ela */
interface CobrancaPendente {
  referenceId: string;
  provider: PaymentProvider;
  configId: string | null;
  /** O que foi pedido à casa, para conferir o que voltou pago */
  chargedAmountCents: number | null;
  eventId: string | null;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  /**
   * O cliente do módulo, e não um `new PrismaClient()` próprio: o middleware
   * de auditoria mora nele. Com o cliente solto, a reconciliação mudava status
   * de pagamento sem deixar uma única linha de log — e é justamente ela que
   * mexe no dinheiro sem ninguém pedir.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentGatewayRegistry,
  ) {}

  @Cron(CronExpression.EVERY_3_HOURS)
  reconcilePayments() {
    // dentro de um contexto próprio: é o que dá nome, id e origem CRON às
    // escritas da rotina, separando-as de uma ação humana no log
    return runAsJob('reconcilePayments', () => this.reconciliar());
  }

  private async reconciliar() {
    this.logger.log('⏳ Iniciando reconciliação de pagamentos...');

    // 1. Busca todos os pagamentos pendentes ou em análise no banco
    const pendentes = await this.prisma.payment.findMany({
      where: {
        status: { in: [PaymentStatus.WAITING, PaymentStatus.IN_ANALYSIS] },
        checkouts: { some: {} },
      },
      select: {
        eventId: true,
        checkouts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            referenceId: true,
            provider: true,
            configId: true,
            chargedAmountCents: true,
          },
        },
      },
    });

    const cobrancas: CobrancaPendente[] = pendentes.flatMap((pagamento) =>
      pagamento.checkouts.map((checkout) => ({
        ...checkout,
        eventId: pagamento.eventId,
      })),
    );

    // A igreja com o módulo de pagamento desligado fica de fora. Desligar o
    // módulo tem que parar tudo, e a reconciliação é justamente a parte que
    // continua rodando sozinha depois que ninguém está mais olhando a tela —
    // sem este filtro ela seguiria consultando a casa e dando baixa numa
    // igreja que, para o resto do sistema, não cobra mais.
    const desligadas = await this.eventosComModuloDesligado(cobrancas);
    const aReconciliar = cobrancas.filter(
      (cobranca) => !cobranca.eventId || !desligadas.has(cobranca.eventId),
    );

    const puladas = cobrancas.length - aReconciliar.length;

    this.logger.log(
      `Encontrados ${pendentes.length} pagamentos pendentes` +
        (puladas ? ` (${puladas} em igreja com o módulo desligado)` : ''),
    );

    // Uma credencial por configuração, e não uma por cobrança: sem isto a
    // rotina abre o envelope cifrado uma vez por linha pendente.
    const casas = new Map<string, GatewayResolvido | null>();

    // 2. Para cada pagamento, consulta a casa que gerou o checkout
    for (const cobranca of aReconciliar) {
      try {
        const casa = await this.casaDa(cobranca, casas);

        if (!casa) {
          this.logger.warn(
            `Sem credencial de ${cobranca.provider} para ${cobranca.referenceId}; pulando.`,
          );
          continue;
        }

        const charges = await casa.gateway.listCharges(
          cobranca.referenceId,
          casa.context,
        );

        if (charges.length === 0) continue;

        const chargeMaisRecente = charges.reduce((atual, item) =>
          item.createdAt > atual.createdAt ? item : atual,
        );

        // Só prossegue se o status for diferente do que está no banco
        const pagamentoNoBanco = await this.prisma.payment.findFirst({
          where: { checkouts: { some: { referenceId: cobranca.referenceId } } },
        });

        if (!pagamentoNoBanco) {
          this.logger.warn(
            `Pagamento com referenceId ${cobranca.referenceId} não encontrado no banco.`,
          );
          continue;
        }

        // "Pago" só vale se o valor bate: a rotina roda sozinha e é justamente
        // ela que confirmaria, sem ninguém olhando, uma cobrança quitada a
        // menos do que devia.
        const statusConferido = conferirValorPago(
          chargeMaisRecente.status,
          chargeMaisRecente.paidAmountCents,
          cobranca.chargedAmountCents,
          cobranca.referenceId,
        );

        if (pagamentoNoBanco.status === statusConferido) {
          this.logger.log(
            `Pagamento ${cobranca.referenceId} já está com status ${statusConferido}, pulando...`,
          );
          continue;
        }

        // 3. Atualiza o status no banco em payments e checkouts
        await this.prisma.$transaction(async (tx) => {
          await tx.payment.updateMany({
            where: {
              checkouts: { some: { referenceId: cobranca.referenceId } },
            },
            data: {
              status: statusConferido,
              method: chargeMaisRecente.method,
              payload: chargeMaisRecente.raw as any,
            },
          });

          if (statusConferido === PaymentStatus.PAID) {
            await tx.paymentCheckout.updateMany({
              where: { referenceId: cobranca.referenceId },
              data: { status: CheckoutStatus.INACTIVE },
            });
          }
        });

        this.logger.log(
          `Pagamento ${cobranca.referenceId} atualizado para ${statusConferido}`,
        );
      } catch (error) {
        if (error instanceof GatewayResourceNotFoundError) {
          this.logger.warn(
            `Pagamento ${cobranca.referenceId} não encontrado em ${cobranca.provider}.`,
          );
          continue;
        }

        this.logger.error(
          `Erro ao consultar ${cobranca.provider} para referenceId ${cobranca.referenceId}: ${error.message}`,
        );
        continue;
      }
    }

    this.logger.log('✅ Reconciliação finalizada');
  }

  /**
   * Os eventos cuja igreja está com o módulo de pagamento desligado.
   *
   * Uma consulta só, sobre os eventos que de fato têm cobrança pendente, em vez
   * de uma por cobrança. Devolve os **desligados** e não os ligados de
   * propósito: cobrança sem evento (`eventId` nulo) não tem igreja a consultar,
   * e perguntar pelos ligados a deixaria de fora sem ninguém ter decidido isso.
   */
  private async eventosComModuloDesligado(
    cobrancas: CobrancaPendente[],
  ): Promise<Set<string>> {
    const eventIds = [
      ...new Set(cobrancas.map((c) => c.eventId).filter(Boolean)),
    ] as string[];

    if (!eventIds.length) return new Set();

    const eventos = await this.prisma.event.findMany({
      where: { id: { in: eventIds }, church: { modulePayment: false } },
      select: { id: true },
    });

    return new Set(eventos.map((evento) => evento.id));
  }

  /**
   * A casa que gerou o checkout, com a credencial reaproveitada entre as
   * cobranças da mesma configuração.
   *
   * O `null` também entra no cache: uma igreja que apagou a credencial tem
   * todas as cobranças dela puladas, e sem guardar a ausência a rotina
   * consultaria o banco uma vez por linha para descobrir o mesmo nada.
   */
  private async casaDa(
    cobranca: CobrancaPendente,
    cache: Map<string, GatewayResolvido | null>,
  ): Promise<GatewayResolvido | null> {
    const chave = cobranca.configId ?? `legado:${cobranca.eventId}`;

    if (cache.has(chave)) return cache.get(chave)!;

    const resolvido = await this.resolver(cobranca);
    cache.set(chave, resolvido);

    return resolvido;
  }

  private async resolver(
    cobranca: CobrancaPendente,
  ): Promise<GatewayResolvido | null> {
    try {
      if (cobranca.configId) {
        return await this.registry.porConfigId(cobranca.configId);
      }

      // Checkout anterior à coluna `configId`: a credencial é a da igreja dona
      // do evento, na casa em que ele nasceu (PagBank, por definição).
      if (!cobranca.eventId) return null;

      const event = await this.prisma.event.findUnique({
        where: { id: cobranca.eventId },
        select: { churchId: true },
      });

      if (!event) return null;

      return await this.registry.porIgrejaEProvider(
        event.churchId,
        cobranca.provider,
      );
    } catch (erro: any) {
      this.logger.warn(
        `Não foi possível abrir a credencial de ${cobranca.provider}: ${erro?.message}`,
      );
      return null;
    }
  }

  /**
   * Tokens de redefinição de senha morrem sozinhos ao serem usados; sobra o
   * caso de quem pediu o código e nunca voltou. A varredura diária impede que
   * essas linhas fiquem paradas no banco depois de vencidas.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  purgeExpiredUserTokens() {
    return runAsJob('purgeExpiredUserTokens', async () => {
      const { count } = await this.prisma.userToken.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      });

      if (count > 0) {
        this.logger.log(`🧹 ${count} token(s) vencido(s) removido(s)`);
      }
    });
  }
}
