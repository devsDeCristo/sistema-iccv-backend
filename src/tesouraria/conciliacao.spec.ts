import { ParaConciliar, sugerirPares } from './conciliacao';

const item = (
  id: string,
  amount: number,
  date: string,
  extra: Partial<ParaConciliar> = {},
): ParaConciliar => ({
  id,
  type: 'INCOME',
  amount,
  date,
  userId: null,
  ...extra,
});

describe('sugerirPares', () => {
  it('casa mesmo tipo e mesmo valor com datas próximas', () => {
    expect(
      sugerirPares(
        [item('b1', 150, '2026-10-05')],
        [item('m1', 150, '2026-10-04')],
      ),
    ).toEqual([{ bancoId: 'b1', manualId: 'm1' }]);
  });

  it('não casa valor diferente, tipo diferente nem data longe demais', () => {
    expect(
      sugerirPares(
        [item('b1', 150, '2026-10-05')],
        [
          item('m1', 150.01, '2026-10-05'),
          item('m2', 150, '2026-10-05', { type: 'EXPENSE' }),
          item('m3', 150, '2026-10-09'),
        ],
      ),
    ).toEqual([]);
  });

  it('compara ao centavo, sem tropeçar no ponto flutuante', () => {
    expect(
      sugerirPares(
        [item('b1', 0.1 + 0.2, '2026-10-05')],
        [item('m1', 0.3, '2026-10-05')],
      ),
    ).toHaveLength(1);
  });

  it('cada lançamento entra em um par só; vence a data mais próxima', () => {
    const pares = sugerirPares(
      [item('b1', 100, '2026-10-05'), item('b2', 100, '2026-10-08')],
      [item('m1', 100, '2026-10-07'), item('m2', 100, '2026-10-05')],
    );
    expect(pares).toEqual(
      expect.arrayContaining([
        { bancoId: 'b1', manualId: 'm2' },
        { bancoId: 'b2', manualId: 'm1' },
      ]),
    );
    expect(pares).toHaveLength(2);
  });

  it('no empate de data, prefere o mesmo dizimista', () => {
    expect(
      sugerirPares(
        [item('b1', 100, '2026-10-05', { userId: 'maria' })],
        [
          item('m1', 100, '2026-10-05', { userId: 'joao' }),
          item('m2', 100, '2026-10-05', { userId: 'maria' }),
        ],
      ),
    ).toEqual([{ bancoId: 'b1', manualId: 'm2' }]);
  });
});
