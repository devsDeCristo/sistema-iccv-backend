import { ForbiddenException } from '@nestjs/common';
import { ADMIN_AREA_ROLES, Role } from './roles';

/**
 * Recorte multi-tenant do sistema: cada igreja (`Church`) enxerga apenas os
 * próprios eventos e as pessoas inscritas neles.
 *
 * Quem tem igreja é só quem entra no painel — admin e financeiro. O usuário
 * comum **não pertence a igreja nenhuma**: ele navega pelo catálogo inteiro e
 * se inscreve em evento de qualquer uma, e é a inscrição que o torna visível
 * para o painel daquela igreja. O super admin atravessa todas.
 */
export type TenantRequester = {
  role?: number | null;
  churchId?: string | null;
};

/** Perfis de painel que obedecem ao recorte por igreja (todos menos o super admin) */
export function isTenantScoped(role?: number | null): boolean {
  return (
    role !== Role.SUPER_ADMIN && ADMIN_AREA_ROLES.includes(role as Role)
  );
}

/**
 * Igreja do requisitante quando ele é recortado, `null` quando atravessa tudo.
 *
 * Falha fechado de propósito: admin sem igreja vinculada não vira super admin
 * por omissão — ele fica sem acesso até alguém corrigir o vínculo. Antes disso
 * a condição era `requester.churchId && ...`, e um `churchId` nulo desligava a
 * checagem inteira, liberando as outras igrejas.
 */
export function tenantChurchId(requester?: TenantRequester | null): string | null {
  if (!requester || !isTenantScoped(requester.role)) return null;

  if (!requester.churchId) {
    throw new ForbiddenException(
      'Seu usuário não está vinculado a uma igreja. Peça ao super admin para definir a igreja do seu perfil.',
    );
  }

  return requester.churchId;
}

/** Barra o acesso quando o recurso é de outra igreja. */
export function assertSameChurch(
  requester: TenantRequester | null | undefined,
  resourceChurchId: string | null | undefined,
  message = 'Este recurso pertence a outra igreja',
): void {
  const churchId = tenantChurchId(requester);
  if (churchId && resourceChurchId !== churchId) {
    throw new ForbiddenException(message);
  }
}

/**
 * `where` do Prisma que limita a lista de pessoas à igreja do requisitante.
 *
 * O que traz alguém para a lista é a participação em um evento da igreja —
 * inscrita ou na lista de espera. O `churchId` direto alcança só o pessoal do
 * painel (admin e financeiro), que precisa se enxergar mesmo sem inscrição;
 * usuário comum não tem igreja e entra apenas pelos eventos.
 *
 * Quem se cadastrou e ainda não se inscreveu em nada não aparece para nenhum
 * admin de igreja — só para o super admin, que vê tudo.
 */
export function userChurchScope(requester?: TenantRequester | null) {
  const churchId = tenantChurchId(requester);
  if (!churchId) return {};

  return {
    OR: [
      { churchId },
      { events: { some: { event: { churchId } } } },
      { waitlists: { some: { event: { churchId } } } },
    ],
  };
}
