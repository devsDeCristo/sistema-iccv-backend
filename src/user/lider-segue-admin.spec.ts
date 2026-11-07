import { UserService } from './user.service';
import { Role } from 'src/auth/roles';

/**
 * O líder espiritual (o pastor) não perde o admin da igreja que lidera: é por
 * ele que entra no painel e dá a confirmação do pastor nas Solicitações. A
 * trava mora em `resolveVinculos`, por onde passam a edição individual e a em
 * massa.
 */
function montar(atuais: { churchId: string; role: number }[]) {
  const prisma = {
    church: {
      count: jest.fn(async ({ where }: any) => where.id.in.length),
      // o pastor lidera a c1
      findFirst: jest.fn(async ({ where }: any) =>
        where.id.in.includes('c1') && where.spiritualLeaderId === 'pastor'
          ? { name: 'Igreja Um' }
          : null,
      ),
    },
    userChurchRole: { findMany: jest.fn(async () => atuais) },
  };
  const servico = new UserService(prisma as any, {} as any, {} as any) as any;
  return (requester: object, pedidos: { churchId: string; role: number }[]) =>
    servico.resolveVinculos(requester, 'pastor', pedidos);
}

const superAdmin = { role: Role.SUPER_ADMIN, churchRoles: [] };
const adminDaC1 = {
  role: Role.ADMIN,
  churchRoles: [{ churchId: 'c1', role: Role.ADMIN }],
};
const adminNaC1 = [{ churchId: 'c1', role: Role.ADMIN }];

describe('UserService — o líder espiritual segue admin da igreja dele', () => {
  it('tirar o admin do pastor na igreja que ele lidera é barrado', async () => {
    const resolver = montar(adminNaC1);
    await expect(resolver(superAdmin, [])).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Igreja Um'),
    });
    await expect(resolver(adminDaC1, [])).rejects.toMatchObject({
      status: 409,
    });
  });

  it('trocar por tesouraria também', async () => {
    const resolver = montar(adminNaC1);
    await expect(
      resolver(superAdmin, [{ churchId: 'c1', role: Role.TESOURARIA }]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('o resto do cadastro dele muda normalmente', async () => {
    const resolver = montar(adminNaC1);
    await expect(
      resolver(superAdmin, [
        { churchId: 'c1', role: Role.ADMIN },
        { churchId: 'c2', role: Role.TESOURARIA },
      ]),
    ).resolves.toHaveLength(2);
  });

  it('o líder que já estava sem o vínculo (dado antigo) não trava a edição', async () => {
    const resolver = montar([]);
    await expect(
      resolver(superAdmin, [{ churchId: 'c2', role: Role.TESOURARIA }]),
    ).resolves.toEqual([{ churchId: 'c2', role: Role.TESOURARIA }]);
  });
});
