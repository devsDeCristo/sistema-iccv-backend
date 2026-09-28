import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { getHeapStatistics } from 'v8';

/**
 * Monitor do processo: atraso do event loop e memória, resumidos a cada minuto.
 *
 * Existe para responder uma pergunta que o log de requisições não responde. O
 * tempo daquele log começa no interceptor, e um pedido que esperou na fila
 * porque o processo estava travado — ou um preflight de CORS, que nem passa
 * por ele — sai com poucos ms enquanto o navegador espera segundos. Aqui fica
 * registrado se o Node travou, quanto e quando, e como estava a memória — do
 * Node e do container, que ele divide com o Chrome do Puppeteer: dá
 * para cruzar com o resto do log (WhatsApp reconectando, PDF sendo gerado).
 *
 * Custo: um histograma nativo com amostra a cada 20ms e um timer por minuto.
 */

/** De quanto em quanto tempo o resumo é feito */
const JANELA_MS = 60_000;

/** Linha de rotina a cada N janelas, mesmo sem nada anormal: a linha de base */
const ROTINA_A_CADA = 10;

/**
 * Acima disso o travamento é sentido por quem está usando: p99 é o atraso que
 * 1% das voltas do loop passou, e o pior caso pega a trava longa e isolada.
 */
const LIMITE_P99_MS = 200;
const LIMITE_PIOR_MS = 1000;

/**
 * Acima desta fração do limite, o container está perto de o kernel começar a
 * tomar memória à força — tudo lá dentro fica lento, o Node junto — ou de
 * matar o processo.
 */
const LIMITE_CONTAINER = 0.9;

export type JanelaDoProcesso = {
  /** atraso do event loop, em ms */
  p50: number;
  p99: number;
  pior: number;
  /** fração do tempo em que o loop esteve ocupado, de 0 a 1 */
  ocupado: number;
  /** memória, em MB */
  rss: number;
  heapUsado: number;
  heapTotal: number;
  heapLimite: number;
  externa: number;
  /**
   * O container inteiro, em MB: o Node e o Chrome do Puppeteer, que é outro
   * processo e não entra no `rss`. Ausente fora de container (a própria
   * máquina) ou sem limite de memória definido.
   */
  container?: { usado: number; limite: number };
};

export function travou(janela: JanelaDoProcesso): boolean {
  const { container } = janela;
  return (
    janela.p99 >= LIMITE_P99_MS ||
    janela.pior >= LIMITE_PIOR_MS ||
    (!!container && container.usado >= container.limite * LIMITE_CONTAINER)
  );
}

export function descreverJanela(janela: JanelaDoProcesso): string {
  return (
    `event loop: p50 ${janela.p50}ms, p99 ${janela.p99}ms, pior ${janela.pior}ms, ` +
    `ocupado ${Math.round(janela.ocupado * 100)}% | ` +
    `memória: rss ${janela.rss}MB, heap ${janela.heapUsado}/${janela.heapTotal}MB ` +
    `(limite ${janela.heapLimite}MB), externa ${janela.externa}MB` +
    (janela.container
      ? ` | container: ${janela.container.usado}/${janela.container.limite}MB`
      : '')
  );
}

const lerArquivo = (caminho: string) => {
  try {
    return readFileSync(caminho, 'utf8').trim();
  } catch {
    return undefined;
  }
};

/**
 * Memória do container, em bytes, pelo cgroup (v2; v1 nos hosts antigos).
 * Desconta o cache de arquivo inativo, que o kernel devolve sem custo quando
 * precisa — é a mesma conta do `docker stats`.
 */
export function memoriaDoContainer(
  ler: (caminho: string) => string | undefined = lerArquivo,
): { usado: number; limite: number } | undefined {
  const inativo = (stat: string | undefined, campo: string) =>
    Number(new RegExp(`^${campo} (\\d+)$`, 'm').exec(stat ?? '')?.[1] ?? 0);

  const v2 = ler('/sys/fs/cgroup/memory.current');
  if (v2 !== undefined) {
    const limite = Number(ler('/sys/fs/cgroup/memory.max')); // "max" = sem limite
    if (!Number.isFinite(limite)) return undefined;
    const stat = ler('/sys/fs/cgroup/memory.stat');
    return { usado: Number(v2) - inativo(stat, 'inactive_file'), limite };
  }

  const v1 = ler('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1 === undefined) return undefined;
  const limite = Number(ler('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
  // sem limite, o v1 informa um número absurdo (~8 EB)
  if (!Number.isFinite(limite) || limite >= 2 ** 60) return undefined;
  const stat = ler('/sys/fs/cgroup/memory/memory.stat');
  return { usado: Number(v1) - inativo(stat, 'total_inactive_file'), limite };
}

export function iniciarMonitorDoProcesso(): void {
  const logger = new Logger('Processo');
  const atraso = monitorEventLoopDelay({ resolution: 20 });
  atraso.enable();

  const ms = (nanossegundos: number) => Math.round(nanossegundos / 1e6);
  const mb = (bytes: number) => Math.round(bytes / 1048576);

  let usoAnterior = performance.eventLoopUtilization();
  let janelas = 0;

  const relogio = setInterval(() => {
    const memoria = process.memoryUsage();
    const container = memoriaDoContainer();
    const janela: JanelaDoProcesso = {
      p50: ms(atraso.percentile(50)),
      p99: ms(atraso.percentile(99)),
      pior: ms(atraso.max),
      ocupado: performance.eventLoopUtilization(usoAnterior).utilization,
      rss: mb(memoria.rss),
      heapUsado: mb(memoria.heapUsed),
      heapTotal: mb(memoria.heapTotal),
      heapLimite: mb(getHeapStatistics().heap_size_limit),
      externa: mb(memoria.external),
      container: container && {
        usado: mb(container.usado),
        limite: mb(container.limite),
      },
    };

    atraso.reset();
    usoAnterior = performance.eventLoopUtilization();
    janelas += 1;

    if (travou(janela)) {
      logger.warn(
        `Processo travou no último minuto — ${descreverJanela(janela)}`,
      );
    } else if (janelas % ROTINA_A_CADA === 0) {
      logger.log(descreverJanela(janela));
    }
  }, JANELA_MS);

  // o monitor não segura o processo aberto (testes, encerramento)
  relogio.unref();
}
