import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ADMIN_AREA_ROLES, Role } from '../auth/roles';
import { EventTenantGuard } from './event-tenant.guard';
import { ROLES_KEY } from './roles.decorator';

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
  'tesouraria-a': {
    role: Role.TESOURARIA,
    churchRoles: [{ churchId: IGREJA_A, role: Role.TESOURARIA }],
  },
  // admin numa igreja e tesouraria na outra
  'dois-chapeus': {
    role: Role.ADMIN,
    churchRoles: [
      { churchId: IGREJA_A, role: Role.ADMIN },
      { churchId: IGREJA_B, role: Role.TESOURARIA },
    ],
  },
  super: { role: Role.SUPER_ADMIN, churchRoles: [] },
  inscrito: { role: Role.USER, churchRoles: [] },
  // só tesoureiro(a) do evento A: continua usuário comum
  'tesoureiro-de-a': { role: Role.USER, churchRoles: [] },
  // tesouraria da igreja A e tesoureira de um evento da B
  'tesouraria-a-tesoureira-de-b': {
    role: Role.TESOURARIA,
    churchRoles: [{ churchId: IGREJA_A, role: Role.TESOURARIA }],
  },
};

const TESOUREIROS = [
  { userId: 'tesoureiro-de-a', eventId: 'evento-a', kind: 'BASICO' },
  {
    userId: 'tesouraria-a-tesoureira-de-b',
    eventId: 'evento-b',
    kind: 'COMPLETO',
  },
];

const EVENTOS: Record<string, { churchId: string }> = {
  'evento-a': { churchId: IGREJA_A },
  'evento-b': { churchId: IGREJA_B },
};

const PAGAMENTOS: Record<string, { eventId: string | null }> = {
  'pag-b': { eventId: 'evento-b' },
  // `Payment.eventId` é opcional no banco; ver o teste do órfão lá embaixo
  'pag-orfao': { eventId: null },
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
  eventTreasurer: {
    findFirst: ({ where }: any) =>
      Promise.resolve(
        TESOUREIROS.find(
          (t) => t.userId === where.userId && t.eventId === where.eventId,
        ) ?? null,
      ),
  },
} as any;

/**
 * O guard lê pelo Reflector o `@Roles` da rota, para saber qual perfil
 * cobrar, e o `@AceitaTesoureiroDoEvento()`.
 */
const guardComRoles = (roles?: Role[], aceitaTesoureiro = false) =>
  new EventTenantGuard(
    {
      getAllAndOverride: (chave: string) =>
        chave === ROLES_KEY ? roles : aceitaTesoureiro,
    } as any,
    prismaFalso,
  );

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

  it('barra a tesouraria no evento de outra igreja', async () => {
    await expect(
      guard.canActivate(contexto('tesouraria-a', { eventId: 'evento-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('barra a tesouraria em rota que exige admin, mesmo na igreja dela', async () => {
    await expect(
      guard.canActivate(contexto('tesouraria-a', { idEvent: 'evento-a' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('aceita a tesouraria na rota que admite tesouraria', async () => {
    const rotaDaTesouraria = guardComRoles([
      Role.SUPER_ADMIN,
      Role.ADMIN,
      Role.TESOURARIA,
    ]);

    await expect(
      rotaDaTesouraria.canActivate(
        contexto('tesouraria-a', { idEvent: 'evento-a' }),
      ),
    ).resolves.toBe(true);
  });

  it('não deixa o perfil de uma igreja valer na outra', async () => {
    // admin na A, tesouraria na B: administrar a B continua barrado
    await expect(
      guard.canActivate(contexto('dois-chapeus', { idEvent: 'evento-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      guard.canActivate(contexto('dois-chapeus', { idEvent: 'evento-a' })),
    ).resolves.toBe(true);
  });

  it('deixa a tesouraria da outra igreja ver o que é de tesouraria lá', async () => {
    const rotaDaTesouraria = guardComRoles([
      Role.SUPER_ADMIN,
      Role.ADMIN,
      Role.TESOURARIA,
    ]);

    await expect(
      rotaDaTesouraria.canActivate(
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
    // a inscrição é área do usuário: rota sem `@Roles`. Em rota de painel o
    // `RolesGuard` já o barra, e aqui ele só passaria como tesoureiro
    await expect(
      guardComRoles().canActivate(
        contexto('inscrito', { idEvent: 'evento-b' }),
      ),
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

  /**
   * Pagamento sem evento não tem igreja, e sem igreja não há o que conferir.
   *
   * O guard devolvia `true` nesse caso, e um admin de qualquer igreja marcava
   * a cobrança como paga. Foi provado contra o servidor de verdade antes da
   * correção: admin da igreja B deu baixa num pagamento órfão e o banco gravou
   * `PAID`. Nenhuma linha assim existe hoje — o schema é que permite.
   */
  it('barra pagamento sem evento, em vez de liberar', async () => {
    await expect(
      guard.canActivate(contexto('admin-a', { paymentId: 'pag-orfao' })),
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

/**
 * O tesoureiro(a) de evento não tem perfil de painel: entra só em rota marcada
 * com `@AceitaTesoureiroDoEvento()`, e só no evento dele. O risco que estes
 * testes fecham é o usuário comum cair no "não é recortado" do guard e
 * alcançar o caixa de qualquer igreja.
 */
describe('EventTenantGuard — tesoureiro(a) do evento', () => {
  const aceita = guardComRoles(ADMIN_AREA_ROLES, true);
  const naoAceita = guardComRoles(ADMIN_AREA_ROLES, false);

  it('deixa o tesoureiro entrar no evento dele em rota que o aceita', async () => {
    await expect(
      aceita.canActivate(contexto('tesoureiro-de-a', { idEvent: 'evento-a' })),
    ).resolves.toBe(true);
  });

  it('barra o tesoureiro em evento que não é dele', async () => {
    await expect(
      aceita.canActivate(contexto('tesoureiro-de-a', { idEvent: 'evento-b' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('barra o tesoureiro em rota que não o aceita, mesmo no evento dele', async () => {
    await expect(
      naoAceita.canActivate(
        contexto('tesoureiro-de-a', { idEvent: 'evento-a' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('barra o inscrito comum, que não é tesoureiro de nada', async () => {
    await expect(
      aceita.canActivate(contexto('inscrito', { idEvent: 'evento-a' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('acha o evento pelo pagamento também para o tesoureiro', async () => {
    await expect(
      aceita.canActivate(
        contexto('tesouraria-a-tesoureira-de-b', { paymentId: 'pag-b' }),
      ),
    ).resolves.toBe(true);
  });

  it('deixa a tesouraria de uma igreja entrar no evento da outra de que é tesoureira', async () => {
    await expect(
      aceita.canActivate(
        contexto('tesouraria-a-tesoureira-de-b', { idEvent: 'evento-b' }),
      ),
    ).resolves.toBe(true);
  });

  it('sem a rota aceitar, a tesouraria de A continua fora do evento de B', async () => {
    await expect(
      naoAceita.canActivate(
        contexto('tesouraria-a-tesoureira-de-b', { idEvent: 'evento-b' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
