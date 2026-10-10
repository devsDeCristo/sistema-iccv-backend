import { HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Fila das gerações de PDF (quadrante, crachás): uma de cada vez.
 *
 * O Chrome de uma geração grande soma ~400 MB à API, que já ocupa ~340 MB, num
 * container de 1 GB. Duas ao mesmo tempo passavam do limite: o container
 * voltava a viver no teto (lento para todo mundo) ou o sistema matava o maior
 * processo — às vezes o Node, derrubando a API inteira. Em fila, o pico é
 * sempre o de uma geração; quem chega depois espera alguns segundos.
 *
 * ponytail: fila em memória, por processo — vale com uma réplica da API, que é
 * o caso. Com mais réplicas cada uma teria a sua fila, e a conta de memória é
 * por container, então continuaria certa; só a posição mostrada seria a da
 * réplica.
 */
const SIMULTANEAS = 1;

/** Mais que isso esperando é rajada: melhor dizer "tente já já" que segurar */
export const MAXIMO_NA_FILA = 20;

type Espera = { pedido: string; liberar: () => void };

const esperando: Espera[] = [];
const gerando = new Set<string>();
let vagasOcupadas = 0;

export type SituacaoNaFila =
  | { estado: 'fila'; posicao: number }
  | { estado: 'gerando' }
  /** ainda não chegou, já terminou, ou o código não é de ninguém */
  | { estado: 'desconhecido' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O código do pedido, que o front manda no cabeçalho `X-Pedido-Pdf` para
 * acompanhar a posição. Sem ele (ou com lixo), um código novo: a geração
 * entra na fila do mesmo jeito, só não dá para acompanhar.
 */
export function codigoDoPedido(cabecalho: unknown): string {
  return typeof cabecalho === 'string' && UUID.test(cabecalho)
    ? cabecalho.toLowerCase()
    : randomUUID();
}

/** Desistência de quem fechou a tela enquanto esperava a vez */
export class DesistiuDaFila extends Error {}

/**
 * Roda `tarefa` quando chegar a vez. `desistir` tira o pedido da fila se a
 * pessoa sair antes da vez dele — sem isso, o PDF de quem fechou a aba ainda
 * seria gerado, ocupando a vez de quem continua esperando. Depois que a vez
 * chegou, a geração vai até o fim.
 */
export async function naFilaDePdf<T>(
  pedido: string,
  tarefa: () => Promise<T>,
  desistir?: AbortSignal,
): Promise<T> {
  if (vagasOcupadas < SIMULTANEAS) {
    vagasOcupadas++;
  } else {
    if (esperando.length >= MAXIMO_NA_FILA) {
      throw new HttpException(
        'Muitos PDFs sendo gerados agora. Tente de novo em instantes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // a vaga é passada adiante por quem termina (ver `finally`): ninguém
    // que chega no meio da troca consegue furar a fila
    await new Promise<void>((liberar, recusar) => {
      const vez: Espera = { pedido, liberar };
      esperando.push(vez);

      desistir?.addEventListener(
        'abort',
        () => {
          const indice = esperando.indexOf(vez);
          if (indice === -1) return; // a vez já tinha chegado
          esperando.splice(indice, 1);
          recusar(new DesistiuDaFila());
        },
        { once: true },
      );
    });
  }

  gerando.add(pedido);
  try {
    return await tarefa();
  } finally {
    gerando.delete(pedido);
    const proximo = esperando.shift();
    if (proximo) proximo.liberar();
    else vagasOcupadas--;
  }
}

/** Onde o pedido está agora — o que o front mostra enquanto espera */
export function situacaoNaFila(pedido: string): SituacaoNaFila {
  const indice = esperando.findIndex((vez) => vez.pedido === pedido);
  if (indice !== -1) return { estado: 'fila', posicao: indice + 1 };
  if (gerando.has(pedido)) return { estado: 'gerando' };
  return { estado: 'desconhecido' };
}

/**
 * A fila a partir da requisição: o código vem do cabeçalho `X-Pedido-Pdf`, e
 * a conexão fechada antes da resposta (aba fechada, navegação) vale como
 * desistência.
 */
export function naFilaDaRequisicao<T>(
  req: { headers: Record<string, unknown> },
  res: {
    on(evento: 'close', ouvinte: () => void): unknown;
    writableFinished: boolean;
  },
  tarefa: () => Promise<T>,
): Promise<T> {
  const desistir = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) desistir.abort();
  });
  return naFilaDePdf(
    codigoDoPedido(req.headers['x-pedido-pdf']),
    tarefa,
    desistir.signal,
  );
}
