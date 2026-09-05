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

type Pessoa = {
  role: number;
  churchRoles: { churchId: string; role: number }[];
};

const PESSOAS: Record<string, Pessoa> = {
  'admin-a': {
    role: Role.ADMIN,
    churchRoles: [{ churchId: IGREJA_A, role: Role.ADMIN }],
  },
  'financeiro-a': {
    role: Role.FINANCE,
    churchRoles: [{ churchId: IGREJA_A, role: Role.FINANCE }],
  },
  // admin numa igreja e financeiro na outra
  'dois-chapeus': {
    role: Role.ADMIN,
    churchRoles: [
      { churchId: IGREJA_A, role: Role.ADMIN },
      { churchId: IGREJA_B, role: Role.FINANCE },
    ],
  },
  super: { role: Role.SUPER_ADMIN, churchRoles: [] },
  inscrito: { role: Role.USER, churchRoles: [] },
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

/** o guard lê o `@Roles` da rota pelo Reflector para saber qual perfil cobrar */
const guardComRoles = (roles?: Role[]) =>
  new EventTenantGuard({ getAllAndOverride: () => roles } as any, prismaFalso);

const guard = guardComRoles([Role.SUPER_ADMIN, Role.ADMIN]);

const contexto = (userId: string | undefined, params: any) =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
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

  it('barra o financeiro em rota que exige admin, mesmo na igreja dele', async () => {
    await expect(
      guard.canActivate(contexto('financeiro-a', { idEvent: 'evento-a' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('aceita o financeiro na rota que admite financeiro', async () => {
    const rotaDoFinanceiro = guardComRoles([
      Role.SUPER_ADMIN,
      Role.ADMIN,
      Role.FINANCE,
    ]);

    await expect(
      rotaDoFinanceiro.canActivate(
        contexto('financeiro-a', { idEvent: 'evento-a' }),
      ),
    ).resolves.toBe(true);
  });

  it('não deixa o perfil de uma igreja valer na outra', async () => {
    // admin na A, financeiro na B: administrar a B continua barrado
    await expect(
      guard.canActivate(contexto('dois-chapeus', { idEvent: 'evento-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      guard.canActivate(contexto('dois-chapeus', { idEvent: 'evento-a' })),
    ).resolves.toBe(true);
  });

  it('deixa o financeiro da outra igreja ver o que é de financeiro lá', async () => {
    const rotaDoFinanceiro = guardComRoles([
      Role.SUPER_ADMIN,
      Role.ADMIN,
      Role.FINANCE,
    ]);

    await expect(
      rotaDoFinanceiro.canActivate(
        contexto('dois-chapeus', { idEvent: 'evento-b' }),
      ),
    ).resolves.toBe(true);
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
    // área do usuário: rota sem `@Roles`, onde ele é um inscrito como outro
    // qualquer e se inscreve em evento de qualquer igreja
    const rotaDoUsuario = guardComRoles();

    await expect(
      rotaDoUsuario.canActivate(
        contexto('admin-a', { idEvent: 'evento-b', idUser: 'admin-a' }),
      ),
    ).resolves.toBe(true);
  });

  it('mantém o recorte na rota de painel, mesmo o alvo sendo ele mesmo', async () => {
    /**
     * O atalho de auto-atendimento não vale onde a rota pede perfil de painel.
     * Sem esta linha o admin da igreja A usava, sobre a própria inscrição,
     * endpoints de painel da igreja B — apagá-la com os pagamentos junto, ou
     * trocar de grupo. Nem os inscritos de lá conseguem fazer isso.
     */
    await expect(
      guard.canActivate(
        contexto('admin-a', { idEvent: 'evento-b', idUser: 'admin-a' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deixa o admin agir sobre a própria inscrição na igreja dele', async () => {
    // o recorte fecha a igreja de fora, não a própria
    await expect(
      guard.canActivate(
        contexto('admin-a', { idEvent: 'evento-a', idUser: 'admin-a' }),
      ),
    ).resolves.toBe(true);
  });

  it('deixa o super admin agir sobre a própria inscrição em qualquer igreja', async () => {
    await expect(
      guard.canActivate(
        contexto('super', { idEvent: 'evento-b', idUser: 'super' }),
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
    await expect(guard.canActivate(contexto('admin-a', {}))).resolves.toBe(
      true,
    );
  });
});
