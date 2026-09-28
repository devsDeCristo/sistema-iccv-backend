import {
  descreverJanela,
  JanelaDoProcesso,
  travou,
} from './monitor-do-processo';

const janela = (valores: Partial<JanelaDoProcesso> = {}): JanelaDoProcesso => ({
  p50: 10,
  p99: 30,
  pior: 80,
  ocupado: 0.12,
  rss: 310,
  heapUsado: 140,
  heapTotal: 180,
  heapLimite: 2048,
  externa: 25,
  ...valores,
});

describe('monitor do processo', () => {
  it('minuto normal não é travamento', () => {
    expect(travou(janela())).toBe(false);
  });

  it('p99 alto é travamento: muitas voltas do loop atrasadas', () => {
    expect(travou(janela({ p99: 250 }))).toBe(true);
  });

  it('uma trava longa isolada também conta, mesmo com p99 baixo', () => {
    // o preflight de 14s: uma trava só, que o p99 dilui no minuto
    expect(travou(janela({ pior: 14_000 }))).toBe(true);
  });

  it('a linha traz atraso, ocupação e memória', () => {
    expect(descreverJanela(janela({ pior: 14_000 }))).toBe(
      'event loop: p50 10ms, p99 30ms, pior 14000ms, ocupado 12% | ' +
        'memória: rss 310MB, heap 140/180MB (limite 2048MB), externa 25MB',
    );
  });
});
