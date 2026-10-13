import { ForbiddenException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { UserService } from './user.service';

/**
 * Recorte do cadastro de pessoas entre igrejas. O caso a cuidar é quem tem
 * perfis diferentes em igrejas diferentes: admin na A, tesouraria na B.
 */
const adminATesourariaB = {
  role: Role.ADMIN,
  churchRoles: [
    { churchId: 'A', role: Role.ADMIN },
    { churchId: 'B', role: Role.TESOURARIA },
  ],
};
const tesourariaDeA = {
  role: Role.TESOURARIA,
  churchRoles: [{ churchId: 'A', role: Role.TESOURARIA }],
};
const adminDeA = {
  role: Role.ADMIN,
  churchRoles: [{ churchId: 'A', role: Role.ADMIN }],
};

const alvo = {
  id: 'alvo',
  role: Role.USER,
  email: 'p@x.com',
  cpf: '1',
  fullName: 'Pessoa',
  religion: 'Católica',
  diabetes: true,
  hypertensive: false,
  sensitiveConsentAt: null,
  password: 'hash',
  churchRoles: [],
};

/**
 * `igrejasDoAlvo`: igrejas em cujos eventos a pessoa está. O `findFirst` com o
 * escopo responde como o banco: acha a pessoa só se alguma igreja pedida no
 * filtro for dela.
 */
function montar(
  requester: object,
  igrejasDoAlvo: string[],
  adminDeEventoEm: string[] = [],
) {
  const pediu = (where: any): string[] =>
    where?.OR?.flatMap((c: any) => c.events?.some?.event?.churchId?.in ?? []) ??
    [];
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'alvo' ? alvo : requester,
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.OR === undefined) return alvo; // super admin, sem recorte
        return pediu(where).some((c) => igrejasDoAlvo.includes(c))
          ? { id: 'alvo' }
          : null;
      }),
    },
    groupRoles: { findMany: jest.fn().mockResolvedValue([]) },
    // admin de um evento em cada igreja de `adminDeEventoEm`
    eventAdmin: {
      findMany: jest.fn().mockResolvedValue(
        adminDeEventoEm.map((churchId) => ({
          event: { id: `ev-${churchId}`, churchId, church: { plan: null } },
        })),
      ),
    },
  };
  return {
    service: new UserService(prisma as any, {} as any, {} as any),
    prisma,
  };
}

describe('Cadastro de pessoas — recorte por igreja', () => {
  it('admin na A e tesouraria na B não edita quem só tem relação com a B', async () => {
    const { service } = montar(adminATesourariaB, ['B']);
    await expect(
      service.update('alvo', { fullName: 'x' } as any, 'req'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('tesouraria lê o cadastro, mas sem saúde e religião', async () => {
    const { service } = montar(tesourariaDeA, ['A']);
    const pessoa: any = await service.findOne('alvo', 'req');
    expect(pessoa.fullName).toBe('Pessoa');
    expect(pessoa).not.toHaveProperty('religion');
    expect(pessoa).not.toHaveProperty('diabetes');
    expect(pessoa).not.toHaveProperty('hypertensive');
  });

  it('admin lê o cadastro completo', async () => {
    const { service } = montar(adminDeA, ['A']);
    const pessoa: any = await service.findOne('alvo', 'req');
    expect(pessoa.religion).toBe('Católica');
  });

  it('tesouraria não troca a foto', async () => {
    const { service } = montar(tesourariaDeA, ['A']);
    await expect(
      service.assertPodeTrocarFoto('req', 'alvo'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('grupos da pessoa: só os da igreja de quem pede, e sem link na espera', async () => {
    const { service, prisma } = montar(adminDeA, ['A']);
    prisma.groupRoles.findMany
      .mockResolvedValueOnce([
        { id: 'g1', link: 'https://chat.whatsapp.com/a' },
      ])
      .mockResolvedValueOnce([
        { id: 'g2', link: 'https://chat.whatsapp.com/b' },
      ]);

    const grupos: any = await service.findUserGroups('alvo', 'req');

    expect(prisma.groupRoles.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          event: { churchId: { in: ['A'] } },
        }),
      }),
    );
    expect(grupos.present[0].link).toBe('https://chat.whatsapp.com/a');
    expect(grupos.waitlist[0]).not.toHaveProperty('link');
  });
});

describe('Cadastro de pessoas — admin de evento', () => {
  const adminDeB = {
    role: Role.ADMIN,
    churchRoles: [{ churchId: 'B', role: Role.ADMIN }],
  };

  it('admin da B e de um evento da A lê o cadastro de alguém da A, completo', async () => {
    const { service } = montar(adminDeB, ['A'], ['A']);
    const pessoa: any = await service.findOne('alvo', 'req');
    expect(pessoa.fullName).toBe('Pessoa');
    expect(pessoa.religion).toBe('Católica');
  });

  it('não alcança quem é de uma igreja de que não é admin de evento nenhum', async () => {
    const { service } = montar(
      { role: Role.USER, churchRoles: [] },
      ['C'],
      ['A'],
    );
    await expect(service.findOne('alvo', 'req')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
