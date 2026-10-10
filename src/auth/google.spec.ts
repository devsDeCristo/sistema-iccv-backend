import { OAuth2Client } from 'google-auth-library';
import * as bcrypt from 'bcrypt';
import { GoogleService } from './google.service';
import { ContaGoogle, conferirTokenDoGoogle } from './google';
import { Role } from './roles';

jest.mock('./google', () => ({
  ...jest.requireActual('./google'),
  conferirTokenDoGoogle: jest.fn(),
}));

const tokenDoGoogle = conferirTokenDoGoogle as jest.Mock;

const conta = (dados: Partial<ContaGoogle> = {}): ContaGoogle => ({
  sub: 'google-1',
  email: 'fulano@gmail.com',
  emailVerificado: true,
  googleEhAutoridade: true,
  ...dados,
});

/**
 * Dublês do banco: `identities` e `users` em memória, com o que o serviço lê.
 * `findByDocument` volta com um vínculo de admin em igreja ativa, para provar
 * que o perfil sai calculado como no login por senha.
 */
async function montar({
  identidades = [] as { id: string; userId: string; subject: string }[],
  usuarios = [{ id: 'u1', cpf: '123', email: 'fulano@gmail.com' }],
} = {}) {
  const hash = await bcrypt.hash('senha-certa', 4);
  const user = (id: string) => usuarios.find((u) => u.id === id);

  const prisma = {
    userIdentity: {
      findUnique: jest.fn(async ({ where }: any) => {
        const achada = where.provider_subject
          ? identidades.find(
              (i) => i.subject === where.provider_subject.subject,
            )
          : identidades.find((i) => i.userId === where.userId_provider.userId);
        if (!achada) return null;
        return {
          ...achada,
          email: 'antigo@gmail.com',
          user: { ...user(achada.userId), fullName: 'Fulano' },
        };
      }),
      findMany: jest.fn(),
      create: jest.fn(async ({ data }: any) => {
        const nova = { id: 'nova', ...data };
        identidades.push(nova);
        return nova;
      }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const achado = where.email
          ? usuarios.find((u) => u.email === where.email)
          : user(where.id);
        if (!achado) return null;
        return {
          ...achado,
          fullName: 'Fulano',
          password: hash,
          identities: identidades.filter((i) => i.userId === achado.id),
        };
      }),
    },
  };

  const users = {
    findByDocument: jest.fn(async (cpf: string) => ({
      ...usuarios.find((u) => u.cpf === cpf),
      password: hash,
      role: Role.USER,
      churchRoles: [{ role: Role.ADMIN, church: { id: 'c1', name: 'C1' } }],
    })),
  };
  const auth = {
    registrarTentativa: jest.fn(),
    login: jest.fn(async (u: any) => ({ access_token: 'jwt', user: u })),
  };
  const mail = { loadTemplate: jest.fn(() => '<html>'), sendMail: jest.fn() };

  const servico = new GoogleService(
    prisma as any,
    users as any,
    auth as any,
    mail as any,
  );
  return { servico, prisma, auth, mail, identidades };
}

describe('GoogleService.entrar', () => {
  it('conta já vinculada: entra com o perfil efetivo e sem o hash', async () => {
    tokenDoGoogle.mockResolvedValue(conta());
    const { servico, prisma, auth, mail } = await montar({
      identidades: [{ id: 'i1', userId: 'u1', subject: 'google-1' }],
    });

    const { user } = await servico.entrar('token');

    expect(user.role).toBe(Role.ADMIN);
    expect(user).not.toHaveProperty('password');
    expect(prisma.userIdentity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'fulano@gmail.com' }),
      }),
    );
    expect(auth.registrarTentativa).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, method: 'GOOGLE' }),
    );
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('primeira vez com Gmail: vincula pelo e-mail, avisa e entra', async () => {
    tokenDoGoogle.mockResolvedValue(conta());
    const { servico, identidades, mail } = await montar();

    await servico.entrar('token');

    expect(identidades).toEqual([
      expect.objectContaining({ userId: 'u1', subject: 'google-1' }),
    ]);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['e-mail que o Google não controla', conta({ googleEhAutoridade: false })],
    ['e-mail não verificado', conta({ emailVerificado: false })],
    ['sem cadastro com o e-mail', conta({ email: 'outro@gmail.com' })],
  ])('não vincula sozinho: %s', async (_caso, contaDoGoogle) => {
    tokenDoGoogle.mockResolvedValue(contaDoGoogle);
    const { servico, identidades, auth } = await montar();

    await expect(servico.entrar('token')).rejects.toThrow(
      'Nenhum cadastro está vinculado',
    );
    expect(identidades).toHaveLength(0);
    expect(auth.registrarTentativa).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, method: 'GOOGLE' }),
    );
  });

  it('cadastro já ligado a outra conta Google: recusa sem trocar', async () => {
    tokenDoGoogle.mockResolvedValue(conta({ sub: 'google-novo' }));
    const { servico, identidades } = await montar({
      identidades: [{ id: 'i1', userId: 'u1', subject: 'google-antigo' }],
    });

    await expect(servico.entrar('token')).rejects.toThrow('outra conta Google');
    expect(identidades).toHaveLength(1);
  });
});

describe('GoogleService.vincular (pelo perfil)', () => {
  it('senha errada: nem confere o token', async () => {
    tokenDoGoogle.mockClear();
    const { servico, identidades } = await montar();

    await expect(
      servico.vincular('u1', 'token', 'senha-errada'),
    ).rejects.toThrow('Senha atual incorreta');
    expect(tokenDoGoogle).not.toHaveBeenCalled();
    expect(identidades).toHaveLength(0);
  });

  it('vincula conta com e-mail diferente do cadastro (Outlook)', async () => {
    tokenDoGoogle.mockResolvedValue(
      conta({ email: 'fulano@outlook.com', googleEhAutoridade: false }),
    );
    const { servico, identidades, mail } = await montar();

    const vinculo = await servico.vincular('u1', 'token', 'senha-certa');

    expect(vinculo).toEqual(
      expect.objectContaining({ email: 'fulano@outlook.com' }),
    );
    expect(vinculo).not.toHaveProperty('subject');
    expect(identidades).toHaveLength(1);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
  });

  it('conta Google de outro cadastro: recusa', async () => {
    tokenDoGoogle.mockResolvedValue(conta());
    const { servico } = await montar({
      identidades: [{ id: 'i1', userId: 'u2', subject: 'google-1' }],
      usuarios: [
        { id: 'u1', cpf: '123', email: 'fulano@gmail.com' },
        { id: 'u2', cpf: '456', email: 'beltrano@gmail.com' },
      ],
    });

    await expect(
      servico.vincular('u1', 'token', 'senha-certa'),
    ).rejects.toThrow('vinculada a outro cadastro');
  });
});

describe('conferirTokenDoGoogle', () => {
  const real = jest.requireActual('./google').conferirTokenDoGoogle;
  // o verifyIdToken tem sobrecarga com callback, que o spyOn tipa como never
  const verificar = jest.spyOn(
    OAuth2Client.prototype,
    'verifyIdToken',
  ) as unknown as jest.Mock;
  const ticket = (payload: object) => ({ getPayload: () => payload } as any);

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'nosso-client-id';
  });
  afterAll(() => {
    delete process.env.GOOGLE_CLIENT_ID;
  });

  it('confere o token contra o nosso Client ID', async () => {
    verificar.mockResolvedValue(
      ticket({ sub: 's', email: 'Fulano@Gmail.com', email_verified: true }),
    );

    expect(await real('token')).toEqual({
      sub: 's',
      email: 'fulano@gmail.com',
      emailVerificado: true,
      googleEhAutoridade: true,
    });
    expect(verificar).toHaveBeenCalledWith({
      idToken: 'token',
      audience: 'nosso-client-id',
    });
  });

  it('Workspace (hd) responde pelo e-mail; Outlook não', async () => {
    verificar.mockResolvedValueOnce(
      ticket({ sub: 's', email: 'a@igreja.org', hd: 'igreja.org' }),
    );
    expect((await real('t')).googleEhAutoridade).toBe(true);

    verificar.mockResolvedValueOnce(
      ticket({ sub: 's', email: 'a@outlook.com', email_verified: true }),
    );
    expect((await real('t')).googleEhAutoridade).toBe(false);
  });

  it('token recusado pelo Google: 400', async () => {
    verificar.mockRejectedValue(new Error('Wrong recipient'));
    await expect(real('token')).rejects.toThrow(
      'Não foi possível confirmar a sua conta Google',
    );
  });

  it('sem GOOGLE_CLIENT_ID: desligado', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    await expect(real('token')).rejects.toThrow('não está habilitado');
  });
});
