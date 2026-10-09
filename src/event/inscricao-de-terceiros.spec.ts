import { ForbiddenException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { EventService } from './event.service';

/**
 * Inscrever outra pessoa: só quem tem painel, e só quem já está no cadastro da
 * igreja de quem pede. Sem a segunda condição, o admin da igreja A trazia
 * qualquer pessoa para o próprio escopo inscrevendo-a pelo id.
 */
function montar(requester: object, noCadastro: boolean) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(requester),
      findFirst: jest.fn().mockResolvedValue(noCadastro ? { id: 'p' } : null),
    },
  };
  const service = new EventService(prisma as any, {} as any, {} as any) as any;
  return { service, prisma };
}

const adminDeA = {
  role: Role.ADMIN,
  churchRoles: [{ churchId: 'A', role: Role.ADMIN }],
};

describe('EventService — inscrição de terceiros', () => {
  it('a própria inscrição passa sem consulta', async () => {
    const { service, prisma } = montar(adminDeA, false);
    await expect(
      service.assertPodeInscrever('eu', 'eu'),
    ).resolves.toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('admin não inscreve quem está fora do cadastro da igreja dele', async () => {
    const { service } = montar(adminDeA, false);
    await expect(
      service.assertPodeInscrever('admin', 'de-fora'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin inscreve quem já está no cadastro da igreja', async () => {
    const { service } = montar(adminDeA, true);
    await expect(
      service.assertPodeInscrever('admin', 'p'),
    ).resolves.toBeUndefined();
  });

  it('super admin inscreve qualquer pessoa', async () => {
    const { service, prisma } = montar(
      { role: Role.SUPER_ADMIN, churchRoles: [] },
      false,
    );
    await expect(
      service.assertPodeInscrever('sa', 'qualquer'),
    ).resolves.toBeUndefined();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('usuário comum não inscreve outra pessoa', async () => {
    const { service } = montar({ role: Role.USER, churchRoles: [] }, true);
    await expect(
      service.assertPodeInscrever('comum', 'outro'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
