import { PaymentProvider } from '@prisma/client';
import { slugDoProvider } from './provider-slug';

/**
 * A URL que a casa recebe para avisar do pagamento.
 *
 * `/webhooks/<casa>/<segredo>/<canal>`.
 *
 * O segredo vai no caminho porque é o único lugar em que ele cabe: das quatro
 * casas, nenhuma deixa cadastrar um cabeçalho próprio na notificação — só a
 * URL. Isso tem um custo, o de a URL ser material sensível (ela aparece em log
 * de acesso e em histórico de navegador), e é por isso que o `LoggingInterceptor`
 * apaga esse trecho e a tela avisa quem cadastra.
 *
 * Uma função só, usada pela tela de configurações e pela criação do checkout:
 * se as duas montassem a URL por conta própria, uma mudança de formato faria a
 * casa avisar num endereço que não existe mais — e o pagamento entraria sem
 * ninguém ficar sabendo.
 */
export function montarUrlDeWebhook(
  provider: PaymentProvider,
  segredo: string,
  canal: string,
): string {
  const base = (process.env.URL_BACKEND ?? '').replace(/\/$/, '');

  return `${base}/webhooks/${slugDoProvider(provider)}/${segredo}/${canal}`;
}

/** O canal principal, por onde vem o aviso de que o dinheiro entrou */
export const CANAL_DE_PAGAMENTO = 'payments';

/** O canal de mudança de estado do próprio checkout — só o PagBank usa hoje */
export const CANAL_DE_CHECKOUT = 'checkouts';
