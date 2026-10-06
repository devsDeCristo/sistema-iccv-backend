import { BadRequestException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { ChurchService } from './church.service';

/**
 * Vincular o líder dá a ele o admin da igreja, e salvar a igreja recalcula o
 * perfil de quem tem vínculo com ela. O Prisma é um dublê: o que importa aqui
 * é o que se escreve.
 *
 * `vinculados` é o que o banco devolve na releitura de `recalcularPerfis` — já
 * com os vínculos de igreja inativa descartados, como faz o `SELECT_TENANT`.
 */
function montar(
  pessoa: { id: string } | null,
  vinculados: {
    id: string;
    role: number;
    churchRoles: { churchId: string; role: number }[];
  }[] = [],
) {
  const tx = {
    church: {
      create: jest.fn().mockResolvedValue({ id: 'igreja-1' }),
      update: jest.fn().mockResolvedValue({ id: 'igreja-1' }),
    },
    userChurchRole: { upsert: jest.fn() },
    user: {
      findMany: jest.fn().mockResolvedValue(vinculados),
      update: jest.fn(),
    },
  };
  const prisma = {
    church: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: 'igreja-1', _count: {} }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(pessoa) },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  };

  return { service: new ChurchService(prisma as any), tx };
}

const admin = { churchId: 'igreja-1', role: Role.ADMIN };

describe('ChurchService — líder espiritual', () => {
  it('quem vira líder vira admin da igreja', async () => {
    const { service, tx } = montar({ id: 'u1' }, [
      { id: 'u1', role: Role.USER, churchRoles: [admin] },
    ]);

    await service.create({ name: 'Igreja Nova', spiritualLeaderId: 'u1' });

    expect(tx.userChurchRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: 'u1', churchId: 'igreja-1', role: Role.ADMIN },
        update: { role: Role.ADMIN },
      }),
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: Role.ADMIN },
    });
  });

  it.each([Role.SUPER_ADMIN, Role.DEV])(
    'perfil global (%s) ganha o vínculo, mas não é rebaixado a admin',
    async (role) => {
      const { service, tx } = montar({ id: 'u1' }, [
        { id: 'u1', role, churchRoles: [admin] },
      ]);

      await service.update('igreja-1', {
        name: 'Igreja',
        spiritualLeaderId: 'u1',
      });

      expect(tx.userChurchRole.upsert).toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
    },
  );

  it('sem líder no corpo, ninguém é promovido', async () => {
    const { service, tx } = montar(null);

    await service.update('igreja-1', { name: 'Igreja' });

    expect(tx.userChurchRole.upsert).not.toHaveBeenCalled();
  });

  it('líder inexistente é 400, não erro de chave estrangeira', async () => {
    const { service } = montar(null);

    await expect(
      service.create({ name: 'Igreja', spiritualLeaderId: 'fantasma' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChurchService — igreja desativada', () => {
  it('quem só administrava ela vira usuário comum', async () => {
    // a releitura já vem sem o vínculo da igreja inativa
    const { service, tx } = montar(null, [
      { id: 'u1', role: Role.ADMIN, churchRoles: [] },
      { id: 'u2', role: Role.FINANCE, churchRoles: [] },
    ]);

    await service.update('igreja-1', { name: 'Igreja', status: 'INACTIVE' });

    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { churchRoles: { some: { churchId: 'igreja-1' } } },
      }),
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: Role.USER },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u2' },
      data: { role: Role.USER },
    });
  });

  it('quem administra outra igreja ativa fica com o perfil de lá', async () => {
    const { service, tx } = montar(null, [
      {
        id: 'u1',
        role: Role.ADMIN,
        churchRoles: [{ churchId: 'igreja-2', role: Role.FINANCE }],
      },
    ]);

    await service.update('igreja-1', { name: 'Igreja', status: 'INACTIVE' });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: Role.FINANCE },
    });
  });

  it('reativar devolve o perfil, sem refazer as permissões', async () => {
    const { service, tx } = montar(null, [
      { id: 'u1', role: Role.USER, churchRoles: [admin] },
    ]);

    await service.update('igreja-1', { name: 'Igreja', status: 'ACTIVE' });

    expect(tx.userChurchRole.upsert).not.toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: Role.ADMIN },
    });
  });

  it.each([Role.SUPER_ADMIN, Role.DEV])(
    'perfil global (%s) não muda',
    async (role) => {
      const { service, tx } = montar(null, [
        { id: 'u1', role, churchRoles: [] },
      ]);

      await service.update('igreja-1', { name: 'Igreja', status: 'INACTIVE' });

      expect(tx.user.update).not.toHaveBeenCalled();
    },
  );
});
