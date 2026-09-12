import { PaymentProvider } from '@prisma/client';

/**
 * Como cada casa aparece na URL de notificação.
 *
 * Um apelido próprio, e não o valor do enum em minúsculas: a URL é cadastrada
 * à mão no painel do provedor e fica lá por anos. Renomear um valor do enum
 * (`MERCADO_PAGO` para `MERCADOPAGO`, por exemplo) quebraria silenciosamente
 * todas as URLs já cadastradas — com este mapa, o enum muda e o apelido fica.
 */
const SLUGS: Record<PaymentProvider, string> = {
  PAGBANK: 'pagbank',
  MERCADO_PAGO: 'mercadopago',
  INFINITEPAY: 'infinitepay',
  TON: 'ton',
};

const POR_SLUG = new Map(
  Object.entries(SLUGS).map(([provider, slug]) => [
    slug,
    provider as PaymentProvider,
  ]),
);

export function slugDoProvider(provider: PaymentProvider): string {
  return SLUGS[provider];
}

/** `null` para um apelido desconhecido — a rota responde 404 sem vazar a lista */
export function providerDoSlug(slug: string): PaymentProvider | null {
  return POR_SLUG.get(slug?.toLowerCase()) ?? null;
}
