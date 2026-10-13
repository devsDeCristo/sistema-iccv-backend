import { ForbiddenException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { EventService } from './event.service';

/**
 * Inscrever outra pessoa: só quem tem painel, e só quem já está no cadastro da
 * igreja de quem pede. Sem a segunda condição, o admin da igreja A trazia
 * qualquer pessoa para o próprio escopo inscrevendo-a pelo id.
 */
function montar(requester: object, noCadastro: boolean, adminDoEvento = false) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(requester),
      findFirst: jest.fn().mockResolvedValue(noCadastro ? { id: 'p' } : null),
    },
    eventAdmin: {
      findFirst: jest
        .fn()
        .mockResolvedValue(adminDoEvento ? { eventId: 'ev' } : null),
    },
    event: { findUnique: jest.fn().mockResolvedValue({ churchId: 'A' }) },
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
      service.assertPodeInscrever('eu', 'eu', 'ev'),
    ).resolves.toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('admin não inscreve quem está fora do cadastro da igreja dele', async () => {
    const { service } = montar(adminDeA, false);
    await expect(
      service.assertPodeInscrever('admin', 'de-fora', 'ev'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin inscreve quem já está no cadastro da igreja', async () => {
    const { service } = montar(adminDeA, true);
    await expect(
      service.assertPodeInscrever('admin', 'p', 'ev'),
    ).resolves.toBeUndefined();
  });

  it('super admin inscreve qualquer pessoa', async () => {
    const { service, prisma } = montar(
      { role: Role.SUPER_ADMIN, churchRoles: [] },
      false,
    );
    await expect(
      service.assertPodeInscrever('sa', 'qualquer', 'ev'),
    ).resolves.toBeUndefined();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('usuário comum não inscreve outra pessoa', async () => {
    const { service } = montar({ role: Role.USER, churchRoles: [] }, true);
    await expect(
      service.assertPodeInscrever('comum', 'outro', 'ev'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EventService — inscrição pelo admin do evento', () => {
  const soAdminDoEvento = { role: Role.USER, churchRoles: [] };

  it('inscreve quem está no cadastro da igreja do evento', async () => {
    const { service, prisma } = montar(soAdminDoEvento, true, true);
    await expect(
      service.assertPodeInscrever('adm-ev', 'p', 'ev'),
    ).resolves.toBeUndefined();
    // o recorte é o da igreja do evento, e não o do perfil (que não tem)
    expect(JSON.stringify(prisma.user.findFirst.mock.calls[0][0])).toContain(
      '"A"',
    );
  });

  it('não inscreve quem está fora da igreja do evento', async () => {
    const { service } = montar(soAdminDoEvento, false, true);
    await expect(
      service.assertPodeInscrever('adm-ev', 'de-fora', 'ev'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
