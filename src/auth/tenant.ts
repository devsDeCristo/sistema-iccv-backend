import { ForbiddenException } from '@nestjs/common';
import {
  ADMIN_AREA_ROLES,
  CHURCH_ROLES,
  Role,
  SUPER_ADMIN_ROLES,
} from './roles';

/**
 * Recorte multi-tenant do sistema.
 *
 * A permissão de quem administra mora em `UserChurchRole`: uma linha por
 * igreja, dizendo se a pessoa é admin ou financeiro **naquela** igreja. A mesma
 * pessoa pode ser admin de uma e financeiro de outra, e o perfil de uma não
 * vale na outra.
 *
 * Fora dos vínculos existem dois perfis, nenhum deles de igreja: o super admin,
 * que atravessa todas, e o usuário comum, que não pertence a nenhuma — ele se
 * inscreve em evento de qualquer igreja, e é a inscrição que o torna visível
 * para aquele painel.
 *
 * `User.role` guarda o perfil efetivo (o mais alto dos vínculos) e serve só
 * para o `RolesGuard` saber se a pessoa pode **chegar** na rota. Qual igreja
 * ela alcança é sempre decidido aqui.
 */
export type VinculoDeIgreja = { churchId: string; role: number };

export type TenantRequester = {
  role?: number | null;
  churchRoles?: VinculoDeIgreja[] | null;
};

/**
 * O que o Prisma precisa trazer do usuário para responder qualquer pergunta de
 * tenant. Num lugar só para que nenhuma consulta esqueça os vínculos e conclua,
 * por engano, que a pessoa não administra nada.
 */
export const SELECT_TENANT = {
  role: true,
  churchRoles: { select: { churchId: true, role: true } },
} as const;

/**
 * Tem poder de super admin, e portanto atravessa todas as igrejas.
 *
 * O dev entra aqui de propósito. Comparar com `Role.SUPER_ADMIN` direto o
 * deixava de fora, e ele até atravessava o recorte — mas por acidente, caindo
 * no ramo do usuário comum em `tenantChurchIds`. Onde a pergunta é feita para
 * conceder algo, e não para filtrar, o acidente virava barreira: em
 * `resolveVinculos` o dev levava 403 ao dar permissão de igreja a alguém.
 */
export function isSuperAdmin(requester?: TenantRequester | null): boolean {
  return SUPER_ADMIN_ROLES.includes(requester?.role as Role);
}

/** Igrejas em que a pessoa tem um dos perfis pedidos. */
export function churchIdsComPerfil(
  requester?: TenantRequester | null,
  roles: number[] = CHURCH_ROLES,
): string[] {
  return (requester?.churchRoles ?? [])
    .filter((vinculo) => roles.includes(vinculo.role))
    .map((vinculo) => vinculo.churchId);
}

/** Perfil da pessoa numa igreja específica, ou `null` se ela não administra lá. */
export function perfilNaIgreja(
  requester: TenantRequester | null | undefined,
  churchId: string,
): number | null {
  const vinculo = (requester?.churchRoles ?? []).find(
    (item) => item.churchId === churchId,
  );

  return vinculo?.role ?? null;
}

/**
 * Igrejas que o requisitante alcança, ou `null` quando não há recorte a aplicar
 * — super admin (atravessa todas) e usuário comum (o catálogo é aberto a ele).
 *
 * Lista vazia é diferente de `null`: significa "nenhuma igreja", e é o que sai
 * quando a rota pede um perfil que a pessoa não tem em lugar nenhum. Fica
 * fechado por padrão, e não aberto.
 */
export function tenantChurchIds(
  requester?: TenantRequester | null,
  roles: number[] = CHURCH_ROLES,
): string[] | null {
  if (isSuperAdmin(requester)) return null;

  /**
   * Quem decide se há recorte é o perfil, não a existência de vínculos.
   *
   * Perguntar "tem vínculo?" abriria um buraco: alguém com perfil de painel e
   * a lista de vínculos vazia — uma igreja apagada, um vínculo removido pela
   * metade — cairia no caminho do usuário comum e passaria a enxergar todas as
   * igrejas. Com o perfil na frente, essa pessoa recebe lista vazia e não
   * alcança nenhuma, que é o lado seguro do erro.
   */
  if (!CHURCH_ROLES.includes(requester?.role as Role)) return null;

  return churchIdsComPerfil(requester, roles);
}

/** Barra o acesso quando o recurso é de uma igreja que a pessoa não alcança. */
export function assertChurchAccess(
  requester: TenantRequester | null | undefined,
  resourceChurchId: string | null | undefined,
  options?: { roles?: number[]; message?: string },
): void {
  const ids = tenantChurchIds(requester, options?.roles);
  if (ids === null) return;

  if (!resourceChurchId || !ids.includes(resourceChurchId)) {
    throw new ForbiddenException(
      options?.message ?? 'Este recurso pertence a outra igreja',
    );
  }
}

/**
 * `where` do Prisma que limita a lista de pessoas às igrejas do requisitante.
 *
 * O que traz alguém para a lista é participar de um evento da igreja —
 * inscrito ou na lista de espera — ou administrar a própria igreja. Usuário
 * comum não tem vínculo e entra só pelos eventos; quem se cadastrou e ainda não
 * se inscreveu em nada não aparece para admin nenhum, só para o super admin.
 */
export function userChurchScope(
  requester?: TenantRequester | null,
  roles: number[] = ADMIN_AREA_ROLES,
) {
  const churchIds = tenantChurchIds(requester, roles);
  if (churchIds === null) return {};

  return {
    OR: [
      { churchRoles: { some: { churchId: { in: churchIds } } } },
      { events: { some: { event: { churchId: { in: churchIds } } } } },
      { waitlists: { some: { event: { churchId: { in: churchIds } } } } },
    ],
  };
}
