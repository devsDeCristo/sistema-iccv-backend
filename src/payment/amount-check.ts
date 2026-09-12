import { Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

const logger = new Logger('ConferenciaDeValor');

/**
 * "Pago" só vale se o valor bate.
 *
 * Sem esta conferência, a baixa depende de um booleano vindo da casa — e numa
 * delas esse booleano é barato de forjar: a API de checkout da InfinitePay não
 * tem autenticação, o `handle` da conta é público (aparece na URL do próprio
 * checkout) e tanto o valor quanto a referência do pedido são escolhidos por
 * quem chama. Quem soubesse a referência da própria inscrição criava um link
 * de um centavo com ela, pagava, e a cobrança de R$ 300 passava a responder
 * "pago" para a conferência e para a reconciliação.
 *
 * Pagamento a menor vira `IN_ANALYSIS` e não `DECLINED`: o dinheiro entrou de
 * verdade e alguém precisa olhar — pode ser o ataque acima, pode ser um acerto
 * legítimo que o sistema não conhece. O que não pode é a inscrição se
 * confirmar sozinha.
 *
 * Pagamento a maior passa: a diferença é acerto de caixa, e travar a inscrição
 * de quem pagou demais seria o pior dos dois erros.
 *
 * @param cobradoEmCentavos o que foi enviado para a casa. Nulo nos checkouts
 * anteriores a esta coluna: ali não há com o que comparar, e recusar tudo o
 * que é antigo derrubaria pagamento legítimo em curso.
 */
export function conferirValorPago(
  status: PaymentStatus,
  pagoEmCentavos: number | null | undefined,
  cobradoEmCentavos: number | null | undefined,
  referencia?: string,
): PaymentStatus {
  if (status !== PaymentStatus.PAID) return status;
  if (
    !cobradoEmCentavos ||
    pagoEmCentavos === null ||
    pagoEmCentavos === undefined
  ) {
    return status;
  }

  if (pagoEmCentavos >= cobradoEmCentavos) return status;

  logger.warn(
    `Cobrança ${referencia ?? '(sem referência)'} voltou como paga com ` +
      `${pagoEmCentavos} centavos, e o cobrado foi ${cobradoEmCentavos}. ` +
      'Marcada para análise em vez de quitada.',
  );

  return PaymentStatus.IN_ANALYSIS;
}
