import { SetMetadata } from '@nestjs/common';
import { Role } from 'src/auth/roles';

export const ROLES_KEY = 'roles';

/**
 * Restringe a rota aos perfis informados. Precisa ser usado junto do
 * `RolesGuard` e depois do `JwtAuthGuard`:
 *
 * `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...ADMIN_ROLES)`
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
