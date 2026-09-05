import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  userId?: string | null;
  /**
   * Identificador da requisição. Uma ação do painel costuma escrever em várias
   * tabelas (inscrever alguém mexe em inscrição, pagamento e vínculo), e é isto
   * que amarra essas linhas como um evento só na tela de atividades.
   */
  requestId?: string;
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
