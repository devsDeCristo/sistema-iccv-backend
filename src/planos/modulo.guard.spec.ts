import { ForbiddenException } from '@nestjs/common';
import { ChurchModule } from '@prisma/client';
import { ModuloGuard } from './modulo.guard';
import { cobraOnline } from './modulos';

/** Igreja A com Eventos e Notícias; B sem plano */
const PLANOS: Record<string, ChurchModule[] | null> = {
  A: [ChurchModule.EVENTS, ChurchModule.NEWS],
  B: null,
};

const prisma = {
  church: {
    findUnique: jest.fn(({ where }) =>
      where.id in PLANOS
        ? {
            name: `Igreja ${where.id}`,
            plan: PLANOS[where.id] ? { modules: PLANOS[where.id] } : null,
          }
        : null,
    ),
  },
  event: {
    findUnique: jest.fn(
      ({ where }) =>
        ({ evA: { churchId: 'A' }, evB: { churchId: 'B' } }[where.id] ?? null),
    ),
  },
  payment: {
    findUnique: jest.fn(
      ({ where }) => ({ pagB: { eventId: 'evB' } }[where.id] ?? null),
    ),
  },
  news: {
    findUnique: jest.fn(
      ({ where }) => ({ notB: { churchId: 'B' } }[where.id] ?? null),
    ),
  },
};

const rodar = (
  modulo: ChurchModule | undefined,
  request: { params?: any; body?: any },
  roles: number[] | undefined = [2],
) => {
  const reflector = {
    getAllAndOverride: jest.fn((chave: string) =>
      chave === 'modulo' ? modulo : roles,
    ),
  };
  const guard = new ModuloGuard(reflector as any, prisma as any);
  const context = {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return guard.canActivate(context as any);
};

describe('ModuloGuard', () => {
  it('libera a igreja cujo plano tem o módulo', async () => {
    await expect(
      rodar(ChurchModule.EVENTS, { params: { churchId: 'A' } }),
    ).resolves.toBe(true);
  });

  it('recusa a igreja sem plano, dizendo qual módulo falta', async () => {
    await expect(
      rodar(ChurchModule.TREASURY, { params: { churchId: 'B' } }),
    ).rejects.toThrow('O plano de Igreja B não inclui o módulo Tesouraria');
  });

  it('recusa a igreja cujo plano não tem o módulo', async () => {
    await expect(
      rodar(ChurchModule.TREASURY, { params: { churchId: 'A' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chega na igreja pelo evento, pelo pagamento, pela notícia e pelo corpo', async () => {
    await expect(
      rodar(ChurchModule.EVENTS, { params: { idEvent: 'evB' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      rodar(ChurchModule.EVENTS, { params: { id: 'evA' } }),
    ).resolves.toBe(true);
    await expect(
      rodar(ChurchModule.EVENTS, { params: { paymentId: 'pagB' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      rodar(ChurchModule.NEWS, { params: { id: 'notB' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      rodar(ChurchModule.EVENTS, { body: { churchId: 'B' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dev e super admin veem todos os módulos, de qualquer igreja', async () => {
    for (const role of [-1, 1]) {
      await expect(
        rodar(ChurchModule.TREASURY, {
          params: { churchId: 'B' },
          user: { role },
        } as any),
      ).resolves.toBe(true);
    }
    // o admin da igreja, não
    await expect(
      rodar(ChurchModule.TREASURY, {
        params: { churchId: 'B' },
        user: { role: 2 },
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('área do usuário (rota sem @Roles) passa: o evento publicado segue aberto', async () => {
    await expect(
      rodar(ChurchModule.EVENTS, { params: { idEvent: 'evB' } }, []),
    ).resolves.toBe(true);
  });

  it('rota sem @Modulo, ou sem igreja para descobrir, passa', async () => {
    await expect(rodar(undefined, { params: { churchId: 'B' } })).resolves.toBe(
      true,
    );
    await expect(rodar(ChurchModule.EVENTS, { params: {} })).resolves.toBe(
      true,
    );
  });
});

describe('cobraOnline', () => {
  it('vem com Eventos no plano; sem Eventos ou sem plano, não cobra', () => {
    expect(cobraOnline({ plan: { modules: [ChurchModule.EVENTS] } })).toBe(
      true,
    );
    expect(cobraOnline({ plan: { modules: [ChurchModule.NEWS] } })).toBe(false);
    expect(cobraOnline({ plan: null })).toBe(false);
    expect(cobraOnline(null)).toBe(false);
  });
});
