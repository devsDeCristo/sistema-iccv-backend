/**
 * Perfis de acesso do sistema. O valor é gravado em `User.role` (Int).
 * Os números não são sequenciais por histórico: 1 (super admin) e 5 (usuário)
 * já existiam em produção antes de admin e financeiro serem criados.
 */
export enum Role {
  SUPER_ADMIN = 1,
  ADMIN = 2,
  FINANCE = 3,
  USER = 5,
}

/** Acesso total ao painel administrativo */
export const ADMIN_ROLES = [Role.SUPER_ADMIN, Role.ADMIN];

/**
 * Perfis que entram no painel administrativo.
 * O financeiro entra, mas só enxerga inscritos e pagamentos dos eventos.
 */
export const ADMIN_AREA_ROLES = [...ADMIN_ROLES, Role.FINANCE];

/** Valores aceitos no campo `role` do usuário */
export const ASSIGNABLE_ROLES = [
  Role.SUPER_ADMIN,
  Role.ADMIN,
  Role.FINANCE,
  Role.USER,
];

export const ROLE_LABELS: Record<number, string> = {
  [Role.SUPER_ADMIN]: 'Super Admin',
  [Role.ADMIN]: 'Admin',
  [Role.FINANCE]: 'Financeiro',
  [Role.USER]: 'Usuário',
};

/** Tem acesso irrestrito ao painel (super admin ou admin) */
export function isAdminRole(role?: number | null): boolean {
  return ADMIN_ROLES.includes(role as Role);
}
