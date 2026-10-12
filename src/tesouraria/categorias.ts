import {
  FinancialCategory,
  FinancialEntryType,
  FinancialMethod,
} from '@prisma/client';
import { TransacaoDoBanco } from 'src/pluggy/pluggy.service';

/** Quais categorias valem para entrada e quais para saída */
export const CATEGORIAS_POR_TIPO: Record<
  FinancialEntryType,
  FinancialCategory[]
> = {
  INCOME: [
    FinancialCategory.TITHE,
    FinancialCategory.OFFERING,
    FinancialCategory.DONATION,
    FinancialCategory.EVENT_INCOME,
    FinancialCategory.OTHER_INCOME,
  ],
  EXPENSE: [
    FinancialCategory.UTILITIES,
    FinancialCategory.RENT,
    FinancialCategory.MAINTENANCE,
    FinancialCategory.SALARIES,
    FinancialCategory.SUPPLIES,
    FinancialCategory.MISSIONS,
    FinancialCategory.EVENT_EXPENSE,
    FinancialCategory.BANK_FEES,
    FinancialCategory.OTHER_EXPENSE,
  ],
};

export const categoriaCabeNoTipo = (
  categoria: FinancialCategory,
  tipo: FinancialEntryType,
) => CATEGORIAS_POR_TIPO[tipo].includes(categoria);

/**
 * Categoria da Pluggy (em inglês) para a nossa, nas saídas. Só as que têm
 * equivalente claro; o resto entra como "outra saída" para a tesouraria
 * reclassificar.
 */
const SAIDAS_DA_PLUGGY: [RegExp, FinancialCategory][] = [
  [/fee|tarif/i, FinancialCategory.BANK_FEES],
  [
    /utilit|electric|energy|water|telecom|internet|phone/i,
    FinancialCategory.UTILITIES,
  ],
  [/rent|aluguel/i, FinancialCategory.RENT],
  [/salar|payroll/i, FinancialCategory.SALARIES],
];

const FORMAS_DA_PLUGGY: Record<string, FinancialMethod> = {
  PIX: FinancialMethod.PIX,
  TED: FinancialMethod.TRANSFER,
  DOC: FinancialMethod.TRANSFER,
  TEF: FinancialMethod.TRANSFER,
  BOLETO: FinancialMethod.BOLETO,
};

/** O dia da transação no horário de Brasília: "2026-10-03" */
export function diaEmBrasilia(iso: string): string {
  // en-CA formata como AAAA-MM-DD
  return new Date(iso).toLocaleDateString('en-CA', {
    timeZone: 'America/Sao_Paulo',
  });
}

/** O dizimista que o CPF do pagador encontrou, e o valor combinado com ele */
export interface DizimistaDoCpf {
  userId: string;
  /** Nulo: sem valor combinado, todo crédito dele é dízimo */
  valor: number | null;
}

/** Mesmo valor, ao centavo: o banco manda 150 e o cadastro tem 150.00 */
const mesmoValor = (a: number, b: number) =>
  Math.round(a * 100) === Math.round(b * 100);

/**
 * Como uma transação do extrato vira lançamento.
 *
 * Crédito cujo pagador tem o CPF de um dizimista da igreja fica ligado a ele,
 * e o valor decide o que é: igual ao dízimo combinado, dízimo; diferente,
 * oferta. Sem valor combinado no cadastro, é dízimo — o Pix do dízimo é o caso
 * comum. Sem dizimista, crédito é "outra entrada". Em todos, a tesouraria
 * corrige a categoria se o palpite errar.
 *
 * `dizimistaPorCpf`: CPF (só dígitos) → dizimista.
 */
export function lancamentoDaTransacao(
  t: TransacaoDoBanco,
  dizimistaPorCpf: Map<string, DizimistaDoCpf>,
) {
  const entrada = t.type === 'CREDIT';
  const dizimista =
    entrada && t.payerDocument ? dizimistaPorCpf.get(t.payerDocument) : null;

  const categoria = entrada
    ? dizimista
      ? dizimista.valor === null || mesmoValor(t.amount, dizimista.valor)
        ? FinancialCategory.TITHE
        : FinancialCategory.OFFERING
      : FinancialCategory.OTHER_INCOME
    : SAIDAS_DA_PLUGGY.find(([padrao]) => padrao.test(t.category ?? ''))?.[1] ??
      FinancialCategory.OTHER_EXPENSE;

  return {
    type: entrada ? FinancialEntryType.INCOME : FinancialEntryType.EXPENSE,
    category: categoria,
    amount: t.amount,
    date: new Date(`${diaEmBrasilia(t.date)}T00:00:00.000Z`),
    description: t.description,
    method: FORMAS_DA_PLUGGY[t.paymentMethod ?? ''] ?? null,
    userId: dizimista?.userId ?? null,
    externalId: t.id,
    bankAccount: t.conta,
    payerName: t.payerName,
  };
}
