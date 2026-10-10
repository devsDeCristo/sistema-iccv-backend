import { Reflector } from '@nestjs/core';
import { Role } from 'src/auth/roles';
import { ROLES_KEY } from 'src/decorators/roles.decorator';
import { LogsController } from './logs.controller';

/**
 * Quem vê os registros: o de atividades é de dev e super admin; o de
 * tentativas de login, só do dev. Lido como o `RolesGuard` lê — o `@Roles` do
 * método vence o da classe.
 */
const perfis = (metodo: keyof LogsController) =>
  new Reflector().getAllAndOverride<Role[]>(ROLES_KEY, [
    LogsController.prototype[metodo],
    LogsController,
  ]);

describe('LogsController — quem acessa', () => {
  it.each(['list', 'operations', 'findOne'] as const)(
    '%s: dev e super admin',
    (metodo) => {
      expect(perfis(metodo)).toEqual([Role.DEV, Role.SUPER_ADMIN]);
    },
  );

  it('tentativas de login: só o dev', () => {
    expect(perfis('loginAttempts')).toEqual([Role.DEV]);
  });
});
