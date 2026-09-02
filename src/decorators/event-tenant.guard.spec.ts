import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '../auth/roles';
import { EventTenantGuard } from './event-tenant.guard';

/**
 * O guard é a fronteira das rotas penduradas em um evento — quartos, equipes,
 * check-in, pagamentos, inscritos. Estes testes fixam quem passa e quem não
 * passa, que é justamente o que uma refatoração descuidada afrouxa sem barulho.
 */

const IGREJA_A = 'igreja-a';
const IGREJA_B = 'igreja-b';

const PESSOAS: Record<string, { role: number; churchId: string | null }> = {
  'admin-a': { role: Role.ADMIN, churchId: IGREJA_A },
  'financeiro-a': { role: Role.FINANCE, churchId: IGREJA_A },
  'super': { role: Role.SUPER_ADMIN, churchId: null },
  'inscrito': { role: Role.USER, churchId: null },
};

const EVENTOS: Record<string, { churchId: string }> = {
  'evento-a': { churchId: IGREJA_A },
  'evento-b': { churchId: IGREJA_B },
};

const PAGAMENTOS: Record<string, { eventId: string | null }> = {
  'pag-b': { eventId: 'evento-b' },
};

const prismaFalso = {
  user: {
    findUnique: ({ where }: any) => Promise.resolve(PESSOAS[where.id] ?? null),
  },
  event: {
    findUnique: ({ where }: any) => Promise.resolve(EVENTOS[where.id] ?? null),
  },
  payment: {
    findUnique: ({ where }: any) =>
      Promise.resolve(PAGAMENTOS[where.id] ?? null),
  },
} as any;

const guard = new EventTenantGuard(prismaFalso);

const contexto = (userId: string | undefined, params: any) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user: userId ? { userId } : undefined, params }),
    }),
  } as any);

describe('EventTenantGuard', () => {
  it('deixa o admin entrar no evento da própria igreja', async () => {
    await expect(
      guard.canActivate(contexto('admin-a', { idEvent: 'evento-a' })),
    ).resolves.toBe(true);
  });

  it('barra o admin no evento de outra igreja', async () => {
    await expect(
      guard.canActivate(contexto('admin-a', { idEvent: 'evento-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('barra o financeiro no evento de outra igreja', async () => {
    await expect(
      guard.canActivate(contexto('financeiro-a', { eventId: 'evento-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deixa o super admin atravessar', async () => {
    await expect(
      guard.canActivate(contexto('super', { idEvent: 'evento-b' })),
    ).resolves.toBe(true);
  });

  it('não recorta o inscrito: ele se inscreve em evento de qualquer igreja', async () => {
    await expect(
      guard.canActivate(contexto('inscrito', { idEvent: 'evento-b' })),
    ).resolves.toBe(true);
  });

  it('libera a ação do admin sobre a própria inscrição em outra igreja', async () => {
    // área do usuário: ali ele é um inscrito como outro qualquer
    await expect(
      guard.canActivate(
        contexto('admin-a', { idEvent: 'evento-b', idUser: 'admin-a' }),
      ),
    ).resolves.toBe(true);
  });

  it('mantém o recorte quando o admin mexe na inscrição de outra pessoa', async () => {
    await expect(
      guard.canActivate(
        contexto('admin-a', { idEvent: 'evento-b', idUser: 'inscrito' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('acha o evento pelo pagamento quando a rota só tem o id dele', async () => {
    await expect(
      guard.canActivate(contexto('admin-a', { paymentId: 'pag-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('recusa quem não está autenticado', async () => {
    await expect(
      guard.canActivate(contexto(undefined, { idEvent: 'evento-a' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('responde 404 para evento inexistente', async () => {
    await expect(
      guard.canActivate(contexto('admin-a', { idEvent: 'sumiu' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deixa passar rota sem evento nenhum na URL', async () => {
    await expect(guard.canActivate(contexto('admin-a', {}))).resolves.toBe(true);
  });
});
