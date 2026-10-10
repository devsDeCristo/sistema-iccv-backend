import { ForbiddenException } from '@nestjs/common';
import { UserService } from './user.service';
import { Role } from 'src/auth/roles';

/**
 * Edição de permissão em massa: cada pessoa vai pelo `update` individual, com
 * a lista de vínculos que resulta da troca. Aqui o `update` é um espião — as
 * travas dele têm spec própria; o que se confere é quem chega até ele e com
 * quais vínculos.
 */
function montar(requester: object) {
  const pessoas = [
    {
      id: 'ana',
      fullName: 'Ana',
      role: Role.FINANCE,
      churchRoles: [
        { churchId: 'c1', role: Role.FINANCE },
        { churchId: 'c2', role: Role.ADMIN },
      ],
    },
    { id: 'bia', fullName: 'Bia', role: Role.USER, churchRoles: [] },
    { id: 'chefe', fullName: 'Chefe', role: Role.SUPER_ADMIN, churchRoles: [] },
    { id: 'eu', fullName: 'Eu', role: Role.ADMIN, churchRoles: [] },
  ];
  const prisma = {
    user: {
      findUnique: jest.fn(async () => requester),
      findMany: jest.fn(async ({ where }: any) =>
        pessoas.filter((p) => where.id.in.includes(p.id)),
      ),
    },
    church: { findUnique: jest.fn(async () => ({ id: 'c1' })) },
  };
  const servico = new UserService(prisma as any, {} as any, {} as any);
  const update = jest.spyOn(servico, 'update').mockResolvedValue(undefined);
  return { servico, update };
}

const adminDaC1 = {
  role: Role.ADMIN,
  churchRoles: [{ role: Role.ADMIN, churchId: 'c1' }],
};

describe('UserService.atualizarPermissoesEmMassa', () => {
  it('admin da igreja: troca o perfil nela e deixa as outras para o update preservar', async () => {
    const { servico, update } = montar(adminDaC1);

    const resultado = await servico.atualizarPermissoesEmMassa('eu', {
      userIds: ['ana', 'bia'],
      churchId: 'c1',
      role: Role.ADMIN,
    });

    expect(resultado).toEqual({ atualizados: 2, falhas: [] });
    // c2 não vai no corpo: não é dele, e o `update` a preserva
    expect(update).toHaveBeenCalledWith(
      'ana',
      { churchRoles: [{ churchId: 'c1', role: Role.ADMIN }] },
      'eu',
    );
    expect(update).toHaveBeenCalledWith(
      'bia',
      { churchRoles: [{ churchId: 'c1', role: Role.ADMIN }] },
      'eu',
    );
  });

  it('role null tira o perfil na igreja', async () => {
    const { servico, update } = montar(adminDaC1);

    await servico.atualizarPermissoesEmMassa('eu', {
      userIds: ['ana'],
      churchId: 'c1',
      role: null,
    });

    expect(update).toHaveBeenCalledWith('ana', { churchRoles: [] }, 'eu');
  });

  it('a própria permissão e super admin ficam de fora, com o motivo', async () => {
    const { servico, update } = montar(adminDaC1);

    const { atualizados, falhas } = await servico.atualizarPermissoesEmMassa(
      'eu',
      { userIds: ['eu', 'chefe', 'bia'], churchId: 'c1', role: Role.FINANCE },
    );

    expect(atualizados).toBe(1);
    expect(falhas.map((f) => f.userId)).toEqual(['eu', 'chefe']);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('recusa do update vira falha daquela pessoa, sem derrubar as outras', async () => {
    const { servico, update } = montar(adminDaC1);
    update.mockRejectedValueOnce(new ForbiddenException('Fora do escopo'));

    const resultado = await servico.atualizarPermissoesEmMassa('eu', {
      userIds: ['ana', 'bia'],
      churchId: 'c1',
      role: Role.ADMIN,
    });

    expect(resultado).toEqual({
      atualizados: 1,
      falhas: [{ userId: 'ana', nome: 'Ana', motivo: 'Fora do escopo' }],
    });
  });

  it('igreja que o admin não administra: 403 antes de tudo', async () => {
    const { servico, update } = montar(adminDaC1);

    await expect(
      servico.atualizarPermissoesEmMassa('eu', {
        userIds: ['bia'],
        churchId: 'c2',
        role: Role.ADMIN,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('quem não é admin: 403', async () => {
    const { servico } = montar({
      role: Role.FINANCE,
      churchRoles: [{ role: Role.FINANCE, churchId: 'c1' }],
    });

    await expect(
      servico.atualizarPermissoesEmMassa('eu', {
        userIds: ['bia'],
        churchId: 'c1',
        role: Role.ADMIN,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
