import { BadRequestException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { ChurchService } from './church.service';

/**
 * Vincular o líder dá a ele o admin da igreja, sem rebaixar quem já é perfil
 * global. O Prisma é um dublê: o que importa aqui é o que se escreve.
 */
function montar(pessoa: { id: string; role: number } | null) {
  const tx = {
    church: {
      create: jest.fn().mockResolvedValue({ id: 'igreja-1' }),
      update: jest.fn().mockResolvedValue({ id: 'igreja-1' }),
    },
    userChurchRole: { upsert: jest.fn() },
    user: { update: jest.fn() },
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

describe('ChurchService — líder espiritual', () => {
  it('quem vira líder vira admin da igreja', async () => {
    const { service, tx } = montar({ id: 'u1', role: Role.USER });

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
      const { service, tx } = montar({ id: 'u1', role });

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
