/**
 * Quais módulos o evento usa.
 *
 * Nem todo evento tem quarto, equipe ou transporte: um encontro de um dia não
 * hospeda ninguém, e um retiro na própria igreja não leva ônibus. Ligado ou
 * desligado é escolha de quem cria o evento, e é isso que decide se a aba
 * aparece no painel.
 *
 * Mora em `Event.data.modules` — JSON, e não colunas — porque a lista cresce
 * com o produto e cada módulo novo custaria uma migração.
 */
export const MODULOS_DO_EVENTO = ['bedrooms', 'teams', 'transport'] as const;

export type ModuloDoEvento = (typeof MODULOS_DO_EVENTO)[number];

export type ModulosDoEvento = Record<ModuloDoEvento, boolean>;

/** Nome de cada módulo em português, para as mensagens de recusa. */
export const NOME_DO_MODULO: Record<ModuloDoEvento, string> = {
  bedrooms: 'Quartos',
  teams: 'Equipes',
  transport: 'Transporte',
};

/**
 * Ausente é ligado.
 *
 * Os eventos que já existem não têm esta chave, e os quartos e as equipes deles
 * estão cheios. Se a ausência valesse "desligado", subir este código esconderia
 * dado cadastrado sem ninguém ter pedido.
 */
export function moduloAtivo(data: unknown, modulo: ModuloDoEvento): boolean {
  const modulos = (data as { modules?: Record<string, unknown> } | null)
    ?.modules;

  return modulos?.[modulo] !== false;
}

export function modulosDoEvento(data: unknown): ModulosDoEvento {
  return MODULOS_DO_EVENTO.reduce((mapa, modulo) => {
    mapa[modulo] = moduloAtivo(data, modulo);
    return mapa;
  }, {} as ModulosDoEvento);
}

/**
 * O que veio do corpo da requisição, reduzido às três chaves conhecidas e a
 * booleano. Sem isto, `data.modules` aceitaria qualquer objeto — e um
 * `{ bedrooms: 'não' }` ligaria o módulo, porque string é verdadeira.
 */
export function normalizarModulos(valor: unknown): ModulosDoEvento {
  const recebido = (valor ?? {}) as Record<string, unknown>;

  return MODULOS_DO_EVENTO.reduce((mapa, modulo) => {
    mapa[modulo] = recebido[modulo] !== false;
    return mapa;
  }, {} as ModulosDoEvento);
}

/**
 * Módulos que estão sendo desligados nesta edição.
 *
 * Só interessa o que muda de ligado para desligado: quem já estava desligado
 * não precisa ser conferido de novo a cada salvamento.
 */
export function modulosDesligados(
  dataAtual: unknown,
  modulosNovos: unknown,
): ModuloDoEvento[] {
  if (modulosNovos === undefined || modulosNovos === null) return [];

  const antes = modulosDoEvento(dataAtual);
  const depois = normalizarModulos(modulosNovos);

  return MODULOS_DO_EVENTO.filter((modulo) => antes[modulo] && !depois[modulo]);
}
