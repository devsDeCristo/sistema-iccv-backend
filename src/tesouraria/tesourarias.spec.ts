import { bancoDe, categoriaValida, periodoDe, separarIds } from './tesourarias';
import { resumir } from './tesourarias.service';

describe('tesourarias de evento e de congregação', () => {
  it('o período como a tela mostra', () => {
    expect(periodoDe('2026-08-07', '2026-08-10')).toBe('07 a 10/08/2026');
    expect(periodoDe('2026-09-30', '2026-10-02')).toBe('30/09 a 02/10/2026');
    expect(periodoDe('2026-12-30', '2027-01-02')).toBe(
      '30/12/2026 a 02/01/2027',
    );
    expect(periodoDe('2026-03-15', '2026-03-15')).toBe('15/03/2026');
    expect(periodoDe('2026-03-15', null)).toBe('15/03/2026');
    expect(periodoDe(null, null)).toBe('');
  });

  it('separa os ids da tela em pagamentos e manuais, e ignora o resto', () => {
    expect(
      separarIds([
        'pagamento:11111111-1111-1111-1111-111111111111',
        'manual:22222222-2222-2222-2222-222222222222',
        'qualquer:coisa',
        'manual:',
      ]),
    ).toEqual({
      pagamentos: ['11111111-1111-1111-1111-111111111111'],
      manuais: ['22222222-2222-2222-2222-222222222222'],
    });
  });

  it('a categoria é do tipo da tesouraria e do lançamento', () => {
    expect(categoriaValida('EVENT', 'EXPENSE', 'Hospedagem')).toBe(true);
    expect(categoriaValida('EVENT', 'INCOME', 'Hospedagem')).toBe(false);
    expect(categoriaValida('CONGREGATION', 'EXPENSE', 'Aluguel')).toBe(true);
    expect(categoriaValida('CONGREGATION', 'EXPENSE', 'Hospedagem')).toBe(
      false,
    );
  });

  it('o banco é o começo do nome da conta', () => {
    expect(bancoDe('Sicredi · Conta corrente')).toBe('Sicredi');
    expect(bancoDe(null)).toBe('Banco');
  });

  it('o resumo soma entradas e saídas ao centavo', () => {
    expect(
      resumir([
        { tipo: 'INCOME', valor: 0.1 },
        { tipo: 'INCOME', valor: 0.2 },
        { tipo: 'EXPENSE', valor: 0.05 },
      ]),
    ).toEqual({ entradas: 0.3, saidas: 0.05, saldo: 0.25 });
  });
});
