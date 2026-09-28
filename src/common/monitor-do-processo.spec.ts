import {
  descreverJanela,
  JanelaDoProcesso,
  memoriaDoContainer,
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

  it('container perto do limite é travamento, mesmo com o loop em dia', () => {
    const container = { usado: 470, limite: 512 };
    expect(travou(janela({ container }))).toBe(true);
    expect(travou(janela({ container: { usado: 300, limite: 512 } }))).toBe(
      false,
    );
    expect(descreverJanela(janela({ container }))).toMatch(
      / \| container: 470\/512MB$/,
    );
  });

  describe('memória do container', () => {
    const arquivos =
      (conteudo: Record<string, string>) => (caminho: string) =>
        conteudo[caminho];

    it('cgroup v2: desconta o cache de arquivo inativo', () => {
      const ler = arquivos({
        '/sys/fs/cgroup/memory.current': '400',
        '/sys/fs/cgroup/memory.max': '512',
        '/sys/fs/cgroup/memory.stat': 'active_file 10\ninactive_file 100\n',
      });
      expect(memoriaDoContainer(ler)).toEqual({ usado: 300, limite: 512 });
    });

    it('cgroup v2 sem limite: não informa', () => {
      const ler = arquivos({
        '/sys/fs/cgroup/memory.current': '400',
        '/sys/fs/cgroup/memory.max': 'max',
      });
      expect(memoriaDoContainer(ler)).toBeUndefined();
    });

    it('cgroup v1', () => {
      const ler = arquivos({
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': '400',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': '512',
        '/sys/fs/cgroup/memory/memory.stat': 'total_inactive_file 50\n',
      });
      expect(memoriaDoContainer(ler)).toEqual({ usado: 350, limite: 512 });
    });

    it('fora de container: não informa', () => {
      expect(memoriaDoContainer(arquivos({}))).toBeUndefined();
    });
  });
});
