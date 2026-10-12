import { ForbiddenException } from '@nestjs/common';
import { ADMIN_AREA_ROLES, Role } from '../auth/roles';
import { ACEITA_TESOUREIRO_KEY } from '../auth/tesoureiro-do-evento';
import { ChurchTenantGuard } from './church-tenant.guard';
import { ROLES_KEY } from './roles.decorator';

/**
 * O caminho do tesoureiro(a) de evento nas rotas `/churches/:churchId/...`:
 * só a rota que o aceita abre, e só na igreja de um evento dele.
 */

const IGREJA_A = 'igreja-a';
const IGREJA_B = 'igreja-b';

const PESSOAS: Record<string, { role: number; churchRoles: any[] }> = {
  'admin-a': {
    role: Role.ADMIN,
    churchRoles: [{ churchId: IGREJA_A, role: Role.ADMIN }],
  },
  // só tesoureiro(a) de um evento da igreja A: continua usuário comum
  'tesoureiro-de-a': { role: Role.USER, churchRoles: [] },
};

const TESOUREIROS = [{ userId: 'tesoureiro-de-a', churchId: IGREJA_A }];

const prismaFalso = {
  user: {
    findUnique: ({ where }: any) => Promise.resolve(PESSOAS[where.id] ?? null),
  },
  church: {
    findUnique: ({ where }: any) => Promise.resolve({ id: where.id }),
  },
  eventTreasurer: {
    findFirst: ({ where }: any) =>
      Promise.resolve(
        TESOUREIROS.find(
          (t) =>
            t.userId === where.userId && t.churchId === where.event?.churchId,
        )
          ? { eventId: 'evento' }
          : null,
      ),
  },
};

const guard = (aceitaTesoureiro: boolean) =>
  new ChurchTenantGuard(
    {
      getAllAndOverride: (chave: string) =>
        chave === ROLES_KEY
          ? ADMIN_AREA_ROLES
          : chave === ACEITA_TESOUREIRO_KEY && aceitaTesoureiro,
    } as any,
    prismaFalso as any,
  );

const contexto = (userId: string, churchId: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user: { userId }, params: { churchId } }),
    }),
    getHandler: () => null,
    getClass: () => null,
  } as any);

describe('ChurchTenantGuard — tesoureiro(a) de evento', () => {
  it('a rota que aceita abre na igreja de um evento dele', async () => {
    await expect(
      guard(true).canActivate(contexto('tesoureiro-de-a', IGREJA_A)),
    ).resolves.toBe(true);
  });

  it('não abre em igreja de que ele não é tesoureiro', async () => {
    await expect(
      guard(true).canActivate(contexto('tesoureiro-de-a', IGREJA_B)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rota que não aceita continua fechada para ele', async () => {
    await expect(
      guard(false).canActivate(contexto('tesoureiro-de-a', IGREJA_A)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('o admin continua só na igreja dele', async () => {
    await expect(
      guard(true).canActivate(contexto('admin-a', IGREJA_A)),
    ).resolves.toBe(true);
    await expect(
      guard(true).canActivate(contexto('admin-a', IGREJA_B)),
    ).rejects.toThrow(ForbiddenException);
  });
});
