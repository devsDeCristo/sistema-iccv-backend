import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_AREA_ROLES, Role } from 'src/auth/roles';
import { RolesGuard } from './roles.guard';

/**
 * O `User.role` gravado pode estar atrasado: a igreja foi desativada antes de
 * o recálculo existir, e o banco ainda diz admin. O guard decide pelo perfil
 * efetivo, a partir dos vínculos que valem (o Prisma já os entrega sem os de
 * igreja inativa).
 */
function montar(pessoa: object | null) {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(pessoa) } };
  const reflector = {
    getAllAndOverride: () => ADMIN_AREA_ROLES,
  } as unknown as Reflector;
  const request = { user: { userId: 'u1' } as Record<string, unknown> };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;

  return { guard: new RolesGuard(reflector, prisma as any), context, request };
}

describe('RolesGuard', () => {
  it('admin gravado sem vínculo que valha é barrado', async () => {
    const { guard, context } = montar({ role: Role.ADMIN, churchRoles: [] });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('admin com vínculo em igreja ativa passa', async () => {
    const { guard, context, request } = montar({
      role: Role.ADMIN,
      churchRoles: [{ churchId: 'igreja-1', role: Role.ADMIN }],
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user.role).toBe(Role.ADMIN);
  });

  it('super admin passa sem vínculo nenhum', async () => {
    const { guard, context } = montar({
      role: Role.SUPER_ADMIN,
      churchRoles: [],
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
