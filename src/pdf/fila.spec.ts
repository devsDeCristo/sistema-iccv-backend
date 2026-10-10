import { HttpException } from '@nestjs/common';
import {
  codigoDoPedido,
  DesistiuDaFila,
  MAXIMO_NA_FILA,
  naFilaDePdf,
  situacaoNaFila,
} from './fila';

/** Uma geração que só termina quando o teste manda */
function geracao() {
  let terminar!: () => void;
  const pronta = new Promise<void>((resolver) => (terminar = resolver));
  return { terminar, tarefa: () => pronta };
}

const esperarTick = () => new Promise((resolver) => setImmediate(resolver));

describe('fila de PDFs', () => {
  it('uma geração por vez, na ordem de chegada, com a posição de quem espera', async () => {
    const [a, b, c] = [geracao(), geracao(), geracao()];
    const ordem: string[] = [];

    const pa = naFilaDePdf(
      'a',
      async () => (await a.tarefa(), ordem.push('a')),
    );
    const pb = naFilaDePdf(
      'b',
      async () => (await b.tarefa(), ordem.push('b')),
    );
    const pc = naFilaDePdf(
      'c',
      async () => (await c.tarefa(), ordem.push('c')),
    );
    await esperarTick();

    expect(situacaoNaFila('a')).toEqual({ estado: 'gerando' });
    expect(situacaoNaFila('b')).toEqual({ estado: 'fila', posicao: 1 });
    expect(situacaoNaFila('c')).toEqual({ estado: 'fila', posicao: 2 });

    // c termina "antes", mas não roda antes de a e b
    c.terminar();
    a.terminar();
    await pa;
    await esperarTick();
    expect(situacaoNaFila('b')).toEqual({ estado: 'gerando' });
    expect(situacaoNaFila('c')).toEqual({ estado: 'fila', posicao: 1 });

    b.terminar();
    await Promise.all([pb, pc]);
    expect(ordem).toEqual(['a', 'b', 'c']);
    expect(situacaoNaFila('a')).toEqual({ estado: 'desconhecido' });
  });

  it('quem desiste sai da fila e não gera', async () => {
    const a = geracao();
    const gerou = jest.fn();
    const desistir = new AbortController();

    const pa = naFilaDePdf('a2', a.tarefa);
    const pb = naFilaDePdf('b2', async () => gerou(), desistir.signal);
    await esperarTick();
    expect(situacaoNaFila('b2')).toEqual({ estado: 'fila', posicao: 1 });

    desistir.abort();
    await expect(pb).rejects.toBeInstanceOf(DesistiuDaFila);
    expect(situacaoNaFila('b2')).toEqual({ estado: 'desconhecido' });

    a.terminar();
    await pa;
    expect(gerou).not.toHaveBeenCalled();
  });

  it('a vaga volta mesmo quando a geração falha', async () => {
    await expect(
      naFilaDePdf('quebrou', async () => {
        throw new Error('chrome caiu');
      }),
    ).rejects.toThrow('chrome caiu');

    // se a vaga tivesse ficado presa, esta esperaria para sempre
    await expect(naFilaDePdf('depois', async () => 'ok')).resolves.toBe('ok');
  });

  it(`com ${MAXIMO_NA_FILA} esperando, o próximo leva 429 na hora`, async () => {
    const primeira = geracao();
    const pa = naFilaDePdf('primeira', primeira.tarefa);
    const fila = Array.from({ length: MAXIMO_NA_FILA }, (_, i) =>
      naFilaDePdf(`f${i}`, async () => undefined),
    );
    await esperarTick();

    const excedente = naFilaDePdf('excedente', async () => undefined);
    await expect(excedente).rejects.toBeInstanceOf(HttpException);
    await expect(excedente).rejects.toMatchObject({ status: 429 });

    primeira.terminar();
    await Promise.all([pa, ...fila]);
  });

  it('o código do pedido só vale como UUID; sem ele, um novo', () => {
    const uuid = '0b6f4c7e-1d2a-4f3b-9c8d-7e6f5a4b3c2d';
    expect(codigoDoPedido(uuid.toUpperCase())).toBe(uuid);
    expect(codigoDoPedido('../../etc')).not.toBe('../../etc');
    expect(codigoDoPedido(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
