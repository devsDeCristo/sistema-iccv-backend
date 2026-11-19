import { ChurchModule } from '@prisma/client';
import { OportunidadesService } from './oportunidades.service';

const VAGA = { id: 'vaga-1', churchId: 'igreja-1', isOpen: true };

/** O banco de mentira: uma igreja, um membro dela e uma vaga */
function montar({
  igrejaDoMembro = { id: 'igreja-1', status: 'ACTIVE' } as any,
  modulos = [ChurchModule.OPPORTUNITIES] as ChurchModule[],
  vaga = VAGA as any,
} = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ memberChurch: igrejaDoMembro })),
    },
    church: {
      findUnique: jest.fn(async () => ({
        name: 'Igreja Um',
        plan: { modules: modulos },
        modulePayment: true,
      })),
    },
    opportunity: {
      // o `where` traz a igreja: vaga de outra igreja não é achada
      findFirst: jest.fn(async ({ where }: any) =>
        vaga && where.id === vaga.id && where.churchId === vaga.churchId
          ? vaga
          : null,
      ),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }: any) => data),
      delete: jest.fn(),
    },
    opportunityInterest: { upsert: jest.fn(), deleteMany: jest.fn() },
  };
  return { service: new OportunidadesService(prisma as any), prisma };
}

describe('OportunidadesService', () => {
  it('o membro demonstra interesse na vaga aberta da igreja dele', async () => {
    const { service, prisma } = montar();
    await expect(service.interessar('u1', 'vaga-1')).resolves.toEqual({
      interessei: true,
    });
    expect(prisma.opportunityInterest.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { opportunityId: 'vaga-1', userId: 'u1' },
      }),
    );
  });

  it('quem não é membro de nenhuma igreja não vê nem se interessa', async () => {
    const { service, prisma } = montar({ igrejaDoMembro: null });
    await expect(service.abertas('u1')).rejects.toMatchObject({ status: 403 });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.opportunityInterest.upsert).not.toHaveBeenCalled();
  });

  it('membro de outra igreja não alcança a vaga (404)', async () => {
    const { service, prisma } = montar({
      igrejaDoMembro: { id: 'igreja-2', status: 'ACTIVE' },
    });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.opportunityInterest.upsert).not.toHaveBeenCalled();
  });

  it('igreja sem Oportunidades no plano recusa', async () => {
    const { service } = montar({ modulos: [ChurchModule.EVENTS] });
    await expect(service.abertas('u1')).rejects.toMatchObject({ status: 403 });
  });

  it('vaga encerrada não recebe interesse', async () => {
    const { service, prisma } = montar({ vaga: { ...VAGA, isOpen: false } });
    await expect(service.interessar('u1', 'vaga-1')).rejects.toMatchObject({
      status: 409,
    });
    expect(prisma.opportunityInterest.upsert).not.toHaveBeenCalled();
  });

  it('o membro só vê as abertas da igreja dele', async () => {
    const { service, prisma } = montar();
    await service.abertas('u1');
    expect(prisma.opportunity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { churchId: 'igreja-1', isOpen: true },
      }),
    );
  });

  it('o admin não mexe na vaga de outra igreja trocando o id', async () => {
    const { service, prisma } = montar();
    await expect(
      service.atualizar('igreja-2', 'vaga-1', { aberta: false }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.excluir('igreja-2', 'vaga-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.opportunity.update).not.toHaveBeenCalled();
    expect(prisma.opportunity.delete).not.toHaveBeenCalled();
  });

  it('encerrar muda só a situação', async () => {
    const { service, prisma } = montar();
    await service.atualizar('igreja-1', 'vaga-1', { aberta: false });
    expect(prisma.opportunity.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isOpen: false } }),
    );
  });
});
