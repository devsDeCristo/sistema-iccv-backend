import { TransacaoDoBanco } from 'src/pluggy/pluggy.service';
import {
  categoriaCabeNoTipo,
  diaEmBrasilia,
  lancamentoDaTransacao,
} from './categorias';

const transacao = (extra: Partial<TransacaoDoBanco>): TransacaoDoBanco => ({
  id: 'tx-1',
  date: '2026-10-03T15:00:00.000Z',
  description: 'PIX RECEBIDO',
  amount: 150,
  type: 'CREDIT',
  category: null,
  paymentMethod: 'PIX',
  payerName: 'Maria',
  payerDocument: '12345678901',
  conta: 'Sicredi · Conta corrente',
  ...extra,
});

describe('lancamentoDaTransacao', () => {
  // Maria sem valor combinado; João com dízimo combinado de R$ 150
  const dizimistas = new Map([
    ['12345678901', { userId: 'user-maria', valor: null }],
    ['98765432100', { userId: 'user-joao', valor: 150 }],
  ]);

  it('Pix de um dizimista sem valor combinado vira dízimo dele', () => {
    const l = lancamentoDaTransacao(transacao({}), dizimistas);
    expect(l).toMatchObject({
      type: 'INCOME',
      category: 'TITHE',
      userId: 'user-maria',
      method: 'PIX',
      externalId: 'tx-1',
      bankAccount: 'Sicredi · Conta corrente',
    });
  });

  it('crédito de quem não é dizimista é outra entrada, sem pessoa', () => {
    const l = lancamentoDaTransacao(
      transacao({ payerDocument: '99999999999' }),
      dizimistas,
    );
    expect(l).toMatchObject({ category: 'OTHER_INCOME', userId: null });
  });

  it('débito nunca vira dízimo, mesmo com o CPF de um dizimista', () => {
    const l = lancamentoDaTransacao(transacao({ type: 'DEBIT' }), dizimistas);
    expect(l).toMatchObject({
      type: 'EXPENSE',
      category: 'OTHER_EXPENSE',
      userId: null,
    });
  });

  it('tarifa e conta de luz da Pluggy viram as categorias de saída', () => {
    expect(
      lancamentoDaTransacao(
        transacao({ type: 'DEBIT', category: 'Bank fees' }),
        dizimistas,
      ).category,
    ).toBe('BANK_FEES');
    expect(
      lancamentoDaTransacao(
        transacao({ type: 'DEBIT', category: 'Electricity' }),
        dizimistas,
      ).category,
    ).toBe('UTILITIES');
  });

  it('TED é transferência; forma desconhecida fica vazia', () => {
    expect(
      lancamentoDaTransacao(transacao({ paymentMethod: 'TED' }), dizimistas)
        .method,
    ).toBe('TRANSFER');
    expect(
      lancamentoDaTransacao(transacao({ paymentMethod: null }), dizimistas)
        .method,
    ).toBeNull();
  });

  it('a data é o dia em Brasília, não em UTC', () => {
    // 01:30 UTC do dia 4 ainda é dia 3 em Brasília
    expect(diaEmBrasilia('2026-10-04T01:30:00.000Z')).toBe('2026-10-03');
    const l = lancamentoDaTransacao(
      transacao({ date: '2026-10-04T01:30:00.000Z' }),
      dizimistas,
    );
    expect(l.date.toISOString().slice(0, 10)).toBe('2026-10-03');
  });
});

describe('lancamentoDaTransacao com o valor do dízimo', () => {
  const dizimistas = new Map([
    ['98765432100', { userId: 'user-joao', valor: 150 }],
  ]);
  const doJoao = (amount: number) =>
    lancamentoDaTransacao(
      transacao({ payerDocument: '98765432100', amount }),
      dizimistas,
    );

  it('o valor combinado é dízimo', () => {
    expect(doJoao(150)).toMatchObject({
      category: 'TITHE',
      userId: 'user-joao',
    });
  });

  it('outro valor do mesmo CPF é oferta, ligada a ele', () => {
    expect(doJoao(50)).toMatchObject({
      category: 'OFFERING',
      userId: 'user-joao',
    });
    expect(doJoao(150.01)).toMatchObject({ category: 'OFFERING' });
  });

  it('compara ao centavo, sem tropeçar no ponto flutuante', () => {
    expect(
      lancamentoDaTransacao(
        transacao({ payerDocument: '98765432100', amount: 0.1 + 0.2 }),
        new Map([['98765432100', { userId: 'u', valor: 0.3 }]]),
      ).category,
    ).toBe('TITHE');
  });
});

describe('categoriaCabeNoTipo', () => {
  it('dízimo é entrada, não saída', () => {
    expect(categoriaCabeNoTipo('TITHE', 'INCOME')).toBe(true);
    expect(categoriaCabeNoTipo('TITHE', 'EXPENSE')).toBe(false);
  });
});
