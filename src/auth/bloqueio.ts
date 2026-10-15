import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Role, SUPER_ADMIN_ROLES } from './roles';

/**
 * O que a pessoa bloqueada lê, no login e quando a sessão cai. Genérico de
 * propósito: o motivo é interno (`UserBlock.reason`), só o super admin vê.
 */
export const MENSAGEM_CONTA_BLOQUEADA =
  'Sua conta está bloqueada. Fale com a organização.';

/** O front reconhece o bloqueio por este código, e não pelo texto */
export const CODIGO_CONTA_BLOQUEADA = 'CONTA_BLOQUEADA';

/** No login: a senha confere, mas a conta não entra */
export const contaBloqueadaNoLogin = () =>
  new ForbiddenException({
    message: MENSAGEM_CONTA_BLOQUEADA,
    code: CODIGO_CONTA_BLOQUEADA,
  });

/**
 * Numa sessão já aberta: 401, e não 403, porque é o 401 que faz o front
 * encerrar a sessão e voltar ao login (ver `api-client.ts`).
 *
 * Não há consulta só para isto: o bloqueio vem junto nas buscas que já leem
 * quem pede — `RolesGuard` (rotas do painel), `/auth/validate` (a cada troca
 * de tela), a inscrição e a sala do check-in.
 */
export const contaBloqueadaNaSessao = () =>
  new UnauthorizedException({
    message: MENSAGEM_CONTA_BLOQUEADA,
    code: CODIGO_CONTA_BLOQUEADA,
  });

/**
 * Quem pode bloquear (e desbloquear) quem. A rota já exige super admin ou
 * dev; aqui fica o resto: ninguém bloqueia a si mesmo, e conta de super admin
 * ou dev só um dev bloqueia — vale o maior perfil.
 */
export function podeBloquear(
  quemPede: { id: string; role: number | null },
  alvo: { id: string; role: number | null },
) {
  if (quemPede.id === alvo.id) return false;
  if (!SUPER_ADMIN_ROLES.includes(quemPede.role as Role)) return false;
  if (SUPER_ADMIN_ROLES.includes(alvo.role as Role)) {
    return quemPede.role === Role.DEV;
  }
  return true;
}
