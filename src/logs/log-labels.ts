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

/**
 * Nome da operação, pela rota que a executou.
 *
 * A tabela responde "o que mudou"; a rota responde "o que a pessoa mandou
 * fazer" — e as duas coisas não são a mesma. Uma inscrição, um cancelamento e
 * uma chamada da lista de espera escrevem nas mesmas duas tabelas, e até aqui
 * as três chegavam à tela com o mesmo nome.
 *
 * A chave é o molde da rota, sem os ids: é o que faz duas inscrições contarem
 * como a mesma operação. Rota fora do mapa cai no próprio caminho — some da
 * lista de filtros, mas nunca vira uma linha sem nome.
 */
export const OPERATION_LABELS: Record<string, string> = {
  // Cadastro
  'POST /users': 'Cadastro de pessoa',
  'PUT /users/:id': 'Edição de cadastro',
  'POST /users/:id/profile-photo': 'Troca de foto do perfil',

  // Senha
  'POST /auth/password/forgot': 'Pedido de redefinição de senha',
  'POST /auth/password/verify-code': 'Conferência do código de redefinição',
  'POST /auth/password/reset': 'Redefinição de senha',

  // Evento
  'POST /events': 'Criação de evento',
  'PUT /events/:id': 'Edição de evento',
  'DELETE /events/:id': 'Exclusão de evento',

  // Inscrição
  'POST /events/:idEvent/users/:idUser': 'Inscrição no evento',
  'PUT /events/:idEvent/users/:idUser': 'Alteração de inscrição',
  'DELETE /events/:idEvent/users/:idUser/rule/:roleRegistrationId':
    'Cancelamento de inscrição',
  'DELETE /events/:idEvent/waitlist/users/:idUser/rule/:roleRegistrationId':
    'Saída da lista de espera',
  'PUT /events/:eventId/waitlist/move': 'Chamada da lista de espera',

  // Dinheiro
  'POST /events/:idEvent/users/:idUser/payments': 'Abertura de cobrança',
  'PUT /payments/:paymentId': 'Baixa de pagamento',
  'PATCH /payments/:paymentId/refund': 'Estorno de pagamento',
  'POST /webhooks/pagbank/checkouts': 'Retorno do PagBank (cobrança)',
  'POST /webhooks/pagbank/payments': 'Retorno do PagBank (pagamento)',

  // Equipe e quarto
  'POST /events/:idEvent/teams': 'Criação de equipe',
  'PUT /events/:idEvent/teams/:idTeam': 'Montagem de equipe',
  'DELETE /events/:idEvent/teams/:id': 'Exclusão de equipe',
  'POST /events/:idEvent/bedrooms': 'Criação de quarto',
  'PUT /events/:idEvent/bedrooms/:idBedrooms': 'Alocação em quarto',
  'DELETE /events/:idEvent/bedrooms/:id': 'Exclusão de quarto',

  // Check-in
  'POST /events/:eventId/checkin/:userId/badge': 'Entrega de crachá',
  'POST /events/:eventId/checkin/:userId/undo-badge': 'Estorno do crachá',
  'POST /events/:eventId/checkin/call-next': 'Chamada do próximo da fila',
  'POST /events/:eventId/checkin/:userId/call': 'Chamada para a foto',
  'POST /events/:eventId/checkin/:userId/complete': 'Conclusão do check-in',
  'POST /events/:eventId/checkin/:userId/undo': 'Volta de etapa do check-in',

  // Igreja e notícia
  'POST /churches': 'Criação de igreja',
  'PUT /churches/:id': 'Edição de igreja',
  'DELETE /churches/:id': 'Exclusão de igreja',
  'POST /news': 'Publicação de notícia',
  'PUT /news/:id': 'Edição de notícia',
  'POST /news/:id/whatsapp': 'Reenvio de notícia no WhatsApp',
  'DELETE /news/:id': 'Exclusão de notícia',
};

export function operationLabel(operation: string | null): string | null {
  if (!operation) return null;

  return OPERATION_LABELS[operation] ?? operation;
}
