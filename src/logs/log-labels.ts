/**
 * Rótulos das colunas "Ação" e "Tabela". O nome cru do model e o verbo em
 * inglês do Prisma não dizem nada para quem opera o painel.
 */

export const ACTION_LABELS: Record<string, string> = {
  create: 'Criou',
  createMany: 'Criou em lote',
  update: 'Alterou',
  updateMany: 'Alterou em lote',
  delete: 'Removeu',
  deleteMany: 'Removeu em lote',
  upsert: 'Criou ou alterou',
};

export const MODEL_LABELS: Record<string, string> = {
  Bedrooms: 'Quarto',
  BedroomsOnUsers: 'Alocação em quarto',
  Checkin: 'Check-in',
  Discounts: 'Desconto',
  Event: 'Evento',
  EventOnUsers: 'Inscrição no evento',
  EventOnUsersRolesRegistration: 'Inscrição por tipo',
  GroupRoles: 'Grupo de inscrição',
  News: 'Notícia',
  NewsOnEvents: 'Envio de notícia (evento)',
  NewsOnGroupRoles: 'Envio de notícia (grupo)',
  Payment: 'Pagamento',
  PaymentCheckout: 'Cobrança',
  RolesRegistration: 'Tipo de inscrição',
  Team: 'Equipe',
  TeamOnUsers: 'Vínculo com equipe',
  User: 'Cadastro',
  UserToken: 'Código de redefinição',
  Waitlist: 'Lista de espera',
  // Legado: saíram do schema, mas as linhas antigas continuam no log
  Church: 'Igreja',
  UserChurchRole: 'Vínculo com igreja',
};

/**
 * Linha antiga em que nada mudou: "Alterou" com conteúdo vazio se contradizia
 * na tela. O middleware já não grava mais essas, mas as que estão na tabela
 * precisam se explicar sozinhas.
 */
const NO_CHANGE_LABEL = 'Salvou sem alterar';

/**
 * Tabelas que representam alguma coisa no mundo, em oposição às que só amarram
 * duas outras. Serve para escolher a linha principal de uma ação: em "removeu
 * vínculo com a igreja + alterou cadastro", o que interessa é o cadastro.
 */
const MAIN_MODELS = new Set([
  'User',
  'Payment',
  'Event',
  'Team',
  'Bedrooms',
  'News',
  'GroupRoles',
  'RolesRegistration',
  'Discounts',
  'Checkin',
  'Waitlist',
  'Church',
]);

export function isMainModel(model: string): boolean {
  return MAIN_MODELS.has(model);
}

export function actionLabel(action: string, hasChanges = true): string {
  // `upsert` fica de fora: o middleware não busca o estado anterior nele, então
  // conteúdo vazio ali não prova que nada mudou.
  if (action.startsWith('update') && !hasChanges) return NO_CHANGE_LABEL;

  return ACTION_LABELS[action] ?? action;
}

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model;
}
