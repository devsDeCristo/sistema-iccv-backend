import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ADMIN_AREA_ROLES, Role } from 'src/auth/roles';
import { ACEITA_TESOUREIRO_KEY } from 'src/auth/tesoureiro-do-evento';
import { ACEITA_ADMIN_DO_EVENTO_KEY } from 'src/auth/admin-do-evento';
import { RolesGuard } from './roles.guard';

/**
 * O `User.role` gravado pode estar atrasado: a igreja foi desativada antes de
 * o recálculo existir, e o banco ainda diz admin. O guard decide pelo perfil
 * efetivo, a partir dos vínculos que valem (o Prisma já os entrega sem os de
 * igreja inativa).
 */
function montar(
  pessoa: object | null,
  {
    aceitaTesoureiro = false,
    tesoureiro = false,
    aceitaAdmin = false,
    adminDeEvento = false,
    roles = ADMIN_AREA_ROLES,
  }: {
    aceitaTesoureiro?: boolean;
    tesoureiro?: boolean;
    aceitaAdmin?: boolean;
    adminDeEvento?: boolean;
    roles?: Role[];
  } = {},
) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(pessoa) },
    eventTreasurer: {
      findFirst: jest
        .fn()
        .mockResolvedValue(tesoureiro ? { eventId: 'evento-1' } : null),
    },
    eventAdmin: {
      findFirst: jest
        .fn()
        .mockResolvedValue(adminDeEvento ? { eventId: 'evento-1' } : null),
    },
  };
  const reflector = {
    getAllAndOverride: (chave: string) =>
      chave === ACEITA_TESOUREIRO_KEY
        ? aceitaTesoureiro
        : chave === ACEITA_ADMIN_DO_EVENTO_KEY
        ? aceitaAdmin
        : roles,
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

  /**
   * O tesoureiro(a) de evento é usuário comum: passa só em rota que o aceita,
   * e o evento certo quem confere é o `EventTenantGuard`.
   */
  it('tesoureiro de evento passa em rota que o aceita', async () => {
    const { guard, context } = montar(
      { role: Role.USER, churchRoles: [] },
      { aceitaTesoureiro: true, tesoureiro: true },
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('tesoureiro de evento é barrado em rota que não o aceita', async () => {
    const { guard, context } = montar(
      { role: Role.USER, churchRoles: [] },
      { tesoureiro: true },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rota que aceita tesoureiro não abre para quem não é tesoureiro', async () => {
    const { guard, context } = montar(
      { role: Role.USER, churchRoles: [] },
      { aceitaTesoureiro: true },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('RolesGuard — admin de evento', () => {
  const soAdminDeEvento = { role: Role.USER, churchRoles: [] };

  it('passa em rota de admin que o aceita (o evento é com o EventTenantGuard)', async () => {
    const { guard, context } = montar(soAdminDeEvento, {
      aceitaAdmin: true,
      adminDeEvento: true,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('é barrado em rota que não o aceita', async () => {
    const { guard, context } = montar(soAdminDeEvento, { adminDeEvento: true });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('é barrado em rota marcada que não aceita admin (só de dev)', async () => {
    const { guard, context } = montar(soAdminDeEvento, {
      aceitaAdmin: true,
      adminDeEvento: true,
      roles: [Role.DEV],
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('quem não é admin de evento nenhum continua barrado', async () => {
    const { guard, context } = montar(soAdminDeEvento, { aceitaAdmin: true });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
