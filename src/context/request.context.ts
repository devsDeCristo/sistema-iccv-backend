import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

/** De onde partiu a escrita. Espelha `PaymentLogSource` no schema. */
export type OrigemDaEscrita = 'PANEL' | 'WEBHOOK' | 'CRON' | 'SYSTEM';

export interface RequestContext {
  userId?: string | null;
  /**
   * Identificador da requisição. Uma ação do painel costuma escrever em várias
   * tabelas (inscrever alguém mexe em inscrição, pagamento e vínculo), e é isto
   * que amarra essas linhas como um evento só na tela de atividades.
   */
  requestId?: string;
  /**
   * O que foi pedido, no molde da rota: `POST /events/:idEvent/users/:idUser`.
   * O `requestId` diz que as escritas são da mesma ação; isto diz qual ação.
   */
  operation?: string;
  /**
   * Quem está por trás da escrita: uma pessoa, o gateway, uma rotina, ou
   * ninguém. É a primeira pergunta do log financeiro — dinheiro que muda de
   * status sozinho e dinheiro que alguém mudou não são o mesmo evento.
   */
  source?: OrigemDaEscrita;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext {
  return requestContext.getStore() || {};
}

export function getCurrentUserId(): string | undefined {
  return getRequestContext().userId ?? undefined;
}

export function getCurrentRequestId(): string | undefined {
  return getRequestContext().requestId;
}

export function getCurrentOperation(): string | undefined {
  return getRequestContext().operation;
}

/**
 * Roda uma rotina automática dentro de um contexto próprio.
 *
 * Sem isto o cron escreve sem id de requisição, sem nome e sem origem: cada
 * linha vira um evento solto no log, e a reconciliação — que muda status de
 * dinheiro sem ninguém pedir — fica indistinguível de uma ação humana.
 */
export function runAsJob<T>(nome: string, executar: () => Promise<T>) {
  return requestContext.run(
    {
      requestId: randomUUID(),
      operation: `CRON ${nome}`,
      source: 'CRON',
    },
    executar,
  );
}
