import * as bcrypt from 'bcrypt';
import { UserService } from 'src/user/user.service';
import { AuthService } from './auth.service';
import { Role } from './roles';

/**
 * Login de quem administra igreja: é admin só se a igreja estiver ativa.
 *
 * O `UserService` é o real; o banco é um dublê que aplica o `where` dos
 * vínculos como o Prisma faria (descarta o da igreja com a situação filtrada).
 * O `role` gravado é ADMIN em todos os casos — quem decide é a igreja.
 */
async function logar(
  role: number,
  vinculos: { status: string; role: number }[],
  { bloqueada = false, senhaDigitada = 'senha-certa' } = {},
  tentativas: any[] = [],
) {
  const senha = 'senha-certa';
  const gravado = {
    id: 'u1',
    cpf: '123',
    role,
    password: await bcrypt.hash(senha, 4),
    churchRoles: vinculos.map(({ status, role: perfil }, i) => ({
      role: perfil,
      church: { id: `igreja-${i}`, name: `Igreja ${i}`, status },
    })),
  };

  const prisma = {
    user: {
      findUnique: jest.fn(async (args: any) => {
        const fora = args.include?.churchRoles?.where?.church?.status?.not;
        return {
          ...gravado,
          // o bloqueio vem na mesma busca (`findByDocument`)
          block: bloqueada ? { userId: 'u1' } : null,
          churchRoles: gravado.churchRoles.filter(
            (vinculo) => vinculo.church.status !== fora,
          ),
        };
      }),
    },
    loginAttempt: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => tentativas.push(data)),
    },
  };

  const users = new UserService(prisma as any, {} as any, {} as any);
  const auth = new AuthService(users, {} as any, prisma as any);
  return auth.validateUser('123', senhaDigitada);
}

describe('AuthService — login de quem administra igreja', () => {
  it('igreja ativa: entra como admin', async () => {
    const user = await logar(Role.ADMIN, [
      { status: 'ACTIVE', role: Role.ADMIN },
    ]);
    expect(user.role).toBe(Role.ADMIN);
  });

  it('igreja inativa: entra como usuário comum, sem a igreja no painel', async () => {
    const user = await logar(Role.ADMIN, [
      { status: 'INACTIVE', role: Role.ADMIN },
    ]);
    expect(user.role).toBe(Role.USER);
    expect(user.churchRoles).toEqual([]);
  });

  it('inativa numa, tesouraria na ativa: fica com o perfil da ativa', async () => {
    const user = await logar(Role.ADMIN, [
      { status: 'INACTIVE', role: Role.ADMIN },
      { status: 'ACTIVE', role: Role.TESOURARIA },
    ]);
    expect(user.role).toBe(Role.TESOURARIA);
  });

  it('super admin não depende de igreja', async () => {
    const user = await logar(Role.SUPER_ADMIN, []);
    expect(user.role).toBe(Role.SUPER_ADMIN);
  });
});

describe('AuthService — conta bloqueada', () => {
  it('senha certa: recusa com o aviso genérico e registra BLOCKED', async () => {
    const tentativas: any[] = [];
    const erro = await logar(Role.USER, [], { bloqueada: true }, tentativas)
      .then(() => null)
      .catch((e) => e);

    expect(erro.getStatus()).toBe(403);
    expect(erro.getResponse()).toEqual({
      message: 'Sua conta está bloqueada. Fale com a organização.',
      code: 'CONTA_BLOQUEADA',
    });
    expect(tentativas).toEqual([
      expect.objectContaining({ success: false, reason: 'BLOCKED' }),
    ]);
  });

  it('senha errada: não conta que a conta está bloqueada', async () => {
    const erro = await logar(Role.USER, [], {
      bloqueada: true,
      senhaDigitada: 'chute',
    })
      .then(() => null)
      .catch((e) => e);

    expect(erro.getStatus()).toBe(401);
    expect(JSON.stringify(erro.getResponse())).not.toContain('bloqueada');
  });
});
