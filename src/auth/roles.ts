/**
 * Perfis de acesso do sistema. O valor é gravado em `User.role` (Int).
 * Os números não são sequenciais por histórico: 1 (super admin) e 5 (usuário)
 * já existiam em produção antes de admin e financeiro serem criados.
 *
 * O dev é -1, e não 0, de propósito: 0 é falsy, e os vários `user.role ||
 * PADRAO` espalhados pelo front rebaixariam o dev para usuário comum sem
 * ninguém perceber.
 */
export enum Role {
  DEV = -1,
  SUPER_ADMIN = 1,
  ADMIN = 2,
  FINANCE = 3,
  USER = 5,
}

/** Perfis com poder de super admin: o dev é super admin com outro rótulo */
export const SUPER_ADMIN_ROLES = [Role.DEV, Role.SUPER_ADMIN];

/** Acesso total ao painel administrativo */
export const ADMIN_ROLES = [...SUPER_ADMIN_ROLES, Role.ADMIN];

/**
 * Perfis que entram no painel administrativo.
 * O financeiro entra, mas só enxerga inscritos e pagamentos dos eventos.
 */
export const ADMIN_AREA_ROLES = [...ADMIN_ROLES, Role.FINANCE];

/**
 * Valores aceitos no campo `role` do usuário. O dev entra aqui para passar na
 * validação do DTO, mas conceder ou remover o perfil exige ser dev — a regra
 * fica em `UserService.update`.
 */
export const ASSIGNABLE_ROLES = [
  Role.DEV,
  Role.SUPER_ADMIN,
  Role.ADMIN,
  Role.FINANCE,
  Role.USER,
];

export const ROLE_LABELS: Record<number, string> = {
  [Role.DEV]: 'Dev',
  [Role.SUPER_ADMIN]: 'Super Admin',
  [Role.ADMIN]: 'Admin',
  [Role.FINANCE]: 'Financeiro',
  [Role.USER]: 'Usuário',
};

/** Tem acesso irrestrito ao painel (dev, super admin ou admin) */
export function isAdminRole(role?: number | null): boolean {
  return ADMIN_ROLES.includes(role as Role);
}

/** Perfil interno de desenvolvimento */
export function isDevRole(role?: number | null): boolean {
  return role === Role.DEV;
}
