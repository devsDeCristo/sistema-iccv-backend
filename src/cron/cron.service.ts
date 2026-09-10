import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CheckoutStatus, PaymentStatus } from '@prisma/client';
import { PagbankService } from 'src/gateways/pagbank/pagbank.service';
import { PrismaService } from 'src/prisma';
import { runAsJob } from 'src/context/request.context';

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
    private readonly pagbankService: PagbankService,
  ) {}

  private PAGBANK_TOKEN = process.env.PAGBANK_TOKEN;

  @Cron(CronExpression.EVERY_3_HOURS)
  reconcilePayments() {
    // dentro de um contexto próprio: é o que dá nome, id e origem CRON às
    // escritas da rotina, separando-as de uma ação humana no log
    return runAsJob('reconcilePayments', () => this.reconciliar());
  }

  private async reconciliar() {
    this.logger.log('⏳ Iniciando reconciliação de pagamentos...');
    // 1. Busca todos os pagamentos pendentes ou em analise no banco
    const pendentes = await this.prisma.payment.findMany({
      where: {
        status: { in: [PaymentStatus.WAITING, PaymentStatus.IN_ANALYSIS] },
        checkouts: { some: {} },
      },
      select: {
        checkouts: {
          orderBy: { createdAt: 'desc' }, // ou created_at dependendo do seu schema
          take: 1,
          select: { referenceId: true },
        },
      },
    });

    const referenceIds = pendentes
      .map((p) => p.checkouts.map((c) => c.referenceId))
      .flat();

    this.logger.log(`Encontrados ${pendentes.length} pagamentos pendentes`);

    // 2. Para cada pagamento, consulta o PagBank
    for (const referenceId of referenceIds) {
      try {
        const response = await this.pagbankService.getPaymentStatus(
          referenceId,
        );

        const chargeMaisRecente = response.reduce((atual, item) => {
          return new Date(item.created_at) > new Date(atual.created_at)
            ? item
            : atual;
        });

        const pagbankStatus = chargeMaisRecente.status as PaymentStatus;

        // Só prossegue se o status for diferente do que está no banco
        const pagamentoNoBanco = await this.prisma.payment.findFirst({
          where: {
            checkouts: { some: { referenceId } },
          },
        });

        if (!pagamentoNoBanco) {
          this.logger.warn(
            `Pagamento com referenceId ${referenceId} não encontrado no banco.`,
          );
          continue;
        }

        if (pagamentoNoBanco.status === pagbankStatus) {
          this.logger.log(
            `Pagamento ${referenceId} já está com status ${pagbankStatus}, pulando...`,
          );
          continue;
        }
        const method = chargeMaisRecente.payment_method.type || null;
        const payload = chargeMaisRecente;

        // 3. Atualiza o status no banco em payments e checkouts
        await this.prisma.$transaction(async (tx) => {
          await tx.payment.updateMany({
            where: {
              checkouts: {
                some: { referenceId },
              },
            },
            data: {
              status: pagbankStatus,
              method,
              payload: payload as any,
            },
          });
          if (pagbankStatus === PaymentStatus.PAID) {
            await tx.paymentCheckout.updateMany({
              where: { referenceId },
              data: {
                status: CheckoutStatus.INACTIVE,
              },
            });
          }
        });
        this.logger.log(
          `Pagamento ${referenceId} atualizado para ${pagbankStatus}`,
        );
      } catch (error) {
        if (error.response && error.status === 404) {
          this.logger.warn(
            `Pagamento ${referenceId} não encontrado no PagBank.`,
          );
          continue;
        }
        this.logger.error(
          `Erro ao consultar PagBank para referenceId ${referenceId}: ${error.message}`,
        );
        continue;
      }
    }

    this.logger.log('✅ Reconciliação finalizada');
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
