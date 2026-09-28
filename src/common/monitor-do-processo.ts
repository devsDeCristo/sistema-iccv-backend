import { Logger } from '@nestjs/common';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { getHeapStatistics } from 'v8';

/**
 * Monitor do processo: atraso do event loop e memória, resumidos a cada minuto.
 *
 * Existe para responder uma pergunta que o log de requisições não responde. O
 * tempo daquele log começa no interceptor, e um pedido que esperou na fila
 * porque o processo estava travado — ou um preflight de CORS, que nem passa
 * por ele — sai com poucos ms enquanto o navegador espera segundos. Aqui fica
 * registrado se o Node travou, quanto e quando, e como estava a memória: dá
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
};

export function travou(janela: JanelaDoProcesso): boolean {
  return janela.p99 >= LIMITE_P99_MS || janela.pior >= LIMITE_PIOR_MS;
}

export function descreverJanela(janela: JanelaDoProcesso): string {
  return (
    `event loop: p50 ${janela.p50}ms, p99 ${janela.p99}ms, pior ${janela.pior}ms, ` +
    `ocupado ${Math.round(janela.ocupado * 100)}% | ` +
    `memória: rss ${janela.rss}MB, heap ${janela.heapUsado}/${janela.heapTotal}MB ` +
    `(limite ${janela.heapLimite}MB), externa ${janela.externa}MB`
  );
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
