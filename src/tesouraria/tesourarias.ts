import {
  FinancialEntryType,
  FinancialMethod,
  PaymentMethod,
  TreasuryAccount,
  TreasuryKind,
} from '@prisma/client';

/**
 * O vocabulário das tesourarias de evento e de congregação, como a tela fala.
 * As regras de quem pode o quê e as consultas ficam no `TesourariasService`;
 * aqui só o que é puro (e testável sem banco).
 */

/** Como a tela chama a conta de cada tesouraria */
export type ContaNaTela = 'ADMINISTRATIVA' | 'EVENTOS' | 'CONGREGACOES';

export const CONTA_NA_TELA: Record<TreasuryAccount, ContaNaTela> = {
  ADMINISTRATIVE: 'ADMINISTRATIVA',
  EVENTS: 'EVENTOS',
  CONGREGATIONS: 'CONGREGACOES',
};

/** A conta própria de cada tipo de tesouraria, com os bancos divididos */
export const CONTA_DO_TIPO: Record<TreasuryKind, TreasuryAccount> = {
  EVENT: TreasuryAccount.EVENTS,
  CONGREGATION: TreasuryAccount.CONGREGATIONS,
};

export const SEM_CATEGORIA = 'Sem categoria';

/**
 * As categorias de uma alocação ou de um lançamento manual. São da conta
 * (Eventos ou Congregações), e não as da Administrativa — por isso texto, e
 * não o enum de `FinancialEntry`.
 */
export const CATEGORIAS: Record<
  'EVENT' | 'CONGREGATION',
  Record<FinancialEntryType, string[]>
> = {
  EVENT: {
    INCOME: [
      'Ingressos',
      'Produtos',
      'Doações',
      'Patrocínio',
      'Outras entradas',
    ],
    EXPENSE: [
      'Hospedagem',
      'Alimentação',
      'Transporte',
      'Materiais',
      'Som e decoração',
      'Tarifas',
      'Outras saídas',
    ],
  },
  CONGREGATION: {
    INCOME: ['Ofertas', 'Campanhas', 'Doações', 'Outras entradas'],
    EXPENSE: [
      'Aluguel',
      'Água e luz',
      'Manutenção',
      'Limpeza',
      'Ação social',
      'Outras saídas',
    ],
  },
};

export const categoriaValida = (
  kind: TreasuryKind,
  tipo: FinancialEntryType,
  categoria: string,
) => CATEGORIAS[kind][tipo].includes(categoria);

export const FORMA_DO_PAGAMENTO: Record<PaymentMethod, string> = {
  PIX: 'Pix',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  CASH: 'Dinheiro',
  BOLETO: 'Boleto',
  OTHER: 'Outra',
};

export const FORMA_DO_MANUAL: Record<FinancialMethod, string> = {
  PIX: 'Pix',
  CASH: 'Dinheiro',
  CARD: 'Cartão',
  TRANSFER: 'Transferência',
  BOLETO: 'Boleto',
  OTHER: 'Outra',
};

/** Em centavos inteiros, para comparar dinheiro sem tropeçar no `Float` */
export const centavos = (valor: number) => Math.round(valor * 100);
export const reais = (valor: number) => Math.round(valor * 100) / 100;

/** "Sicredi · Conta corrente" → "Sicredi" */
export const bancoDe = (conta: string | null) =>
  conta?.split(' · ')[0]?.trim() || 'Banco';

/**
 * O id que a tela usa para um lançamento do sistema: o pagamento e o manual
 * moram em tabelas diferentes, e a ação precisa saber de qual é.
 */
export const idDoPagamento = (id: string) => `pagamento:${id}`;
export const idDoManual = (id: string) => `manual:${id}`;

export function separarIds(ids: string[]) {
  const pagamentos: string[] = [];
  const manuais: string[] = [];
  for (const id of ids) {
    const [tipo, valor] = id.split(':');
    if (tipo === 'pagamento' && valor) pagamentos.push(valor);
    else if (tipo === 'manual' && valor) manuais.push(valor);
  }
  return { pagamentos, manuais };
}

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const dataCurta = (dia: string) => {
  const [, a, m, d] = DIA.exec(dia) ?? [];
  return a ? `${d}/${m}/${a}` : dia;
};

/**
 * "07 a 10/08/2026", "30/09 a 02/10/2026", "15/03/2026". Vazio sem data.
 */
export function periodoDe(inicio: string | null, fim: string | null) {
  if (!inicio) return '';
  if (!fim || fim === inicio) return dataCurta(inicio);
  const [ai, mi, di] = inicio.split('-');
  const [af, mf] = fim.split('-');
  if (ai !== af) return `${dataCurta(inicio)} a ${dataCurta(fim)}`;
  if (mi !== mf) return `${di}/${mi} a ${dataCurta(fim)}`;
  return `${di} a ${dataCurta(fim)}`;
}

/** Entradas menos saídas, com o sinal do tipo */
export const comSinal = (tipo: FinancialEntryType, valor: number) =>
  tipo === FinancialEntryType.INCOME ? valor : -valor;
