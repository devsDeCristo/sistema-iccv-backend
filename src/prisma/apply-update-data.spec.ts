import { applyUpdateData } from './prisma.service';

/**
 * O cálculo do "depois" de um `updateMany` feito dentro de uma transação.
 *
 * Dentro dela a releitura roda por fora e devolve o estado antigo, então o log
 * conclui que nada mudou e a escrita some da auditoria. Quem impede isso é
 * esta conta — e ela precisa valer justamente para a escrita que mais importa
 * auditar: a baixa de pagamento, que carrega o retorno do gateway num campo
 * `Json`.
 */
describe('applyUpdateData', () => {
  const antes = [
    { id: '1', status: 'WAITING', method: 'OTHER', payload: null, amount: 300 },
    { id: '2', status: 'WAITING', method: 'OTHER', payload: null, amount: 150 },
  ];

  it('aplica valores simples em todas as linhas', () => {
    const depois = applyUpdateData(antes, { status: 'PAID', method: 'PIX' });

    expect(depois).toEqual([
      { ...antes[0], status: 'PAID', method: 'PIX' },
      { ...antes[1], status: 'PAID', method: 'PIX' },
    ]);
  });

  it('aplica campo Json — o caso da baixa de pagamento', () => {
    // Antes, objeto era tratado como imprevisível e a conta era abandonada:
    // a reconciliação e o retorno do gateway mudavam status sem deixar log.
    const payload = { payment_method: { type: 'PIX' }, links: [] };

    const depois = applyUpdateData(antes, { status: 'PAID', payload });

    expect(depois?.[0].payload).toEqual(payload);
    expect(depois?.[0].status).toBe('PAID');
  });

  it('aplica lista atribuída inteira', () => {
    const depois = applyUpdateData([{ id: '1', tag: [] }], {
      tag: ['azul', 'verde'],
    });

    expect(depois?.[0].tag).toEqual(['azul', 'verde']);
  });

  it('aplica Json vazio', () => {
    // `{}` não tem chave de operador nenhuma: atribuí-lo é previsível
    expect(applyUpdateData(antes, { payload: {} })?.[0].payload).toEqual({});
  });

  describe('desiste quando o resultado depende do banco', () => {
    it('recusa operador aritmético', () => {
      expect(applyUpdateData(antes, { amount: { increment: 10 } })).toBeNull();
    });

    it('recusa push em lista', () => {
      expect(
        applyUpdateData([{ id: '1', tag: [] }], { tag: { push: 'x' } }),
      ).toBeNull();
    });

    it('recusa quando só um dos campos é operador', () => {
      expect(
        applyUpdateData(antes, {
          status: 'PAID',
          amount: { decrement: 5 },
        }),
      ).toBeNull();
    });

    it('recusa o Json escrito com `set`', () => {
      // Ambíguo de propósito: `{ set: ... }` é a forma de operador, e na dúvida
      // vale desistir da conta em vez de gravar um "depois" inventado.
      expect(applyUpdateData(antes, { payload: { set: { a: 1 } } })).toBeNull();
    });
  });

  it('recusa entrada que não é lista de linhas', () => {
    expect(applyUpdateData(null, { status: 'PAID' })).toBeNull();
    expect(applyUpdateData({ id: '1' }, { status: 'PAID' })).toBeNull();
    expect(applyUpdateData(antes, null)).toBeNull();
  });
});
