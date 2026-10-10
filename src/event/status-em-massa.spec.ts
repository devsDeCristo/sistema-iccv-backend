import { EventStatus } from '@prisma/client';
import { EventService } from './event.service';
import { Role } from 'src/auth/roles';

/**
 * Status em massa: cada evento é conferido contra a igreja de quem pede; os
 * que passam mudam num `updateMany` só, os outros voltam em `falhas`.
 */
function montar(requester: object) {
  const eventos = [
    { id: 'e1', name: 'Retiro', churchId: 'c1', status: EventStatus.ACTIVE },
    { id: 'e2', name: 'Cursilho', churchId: 'c1', status: EventStatus.TEST },
    {
      id: 'e3',
      name: 'Da vizinha',
      churchId: 'c2',
      status: EventStatus.ACTIVE,
    },
  ];
  const prisma = {
    user: { findUnique: jest.fn(async () => requester) },
    event: {
      findMany: jest.fn(async ({ where }: any) =>
        eventos.filter((e) => where.id.in.includes(e.id)),
      ),
      updateMany: jest.fn(async ({ where }: any) => ({
        count: where.id.in.length,
      })),
    },
  };
  const servico = new EventService(prisma as any, {} as any, {} as any);
  return { servico, prisma };
}

const adminDaC1 = {
  role: Role.ADMIN,
  churchRoles: [{ role: Role.ADMIN, churchId: 'c1' }],
};

describe('EventService.atualizarStatusEmMassa', () => {
  it('muda os da igreja dele e devolve o da vizinha como falha', async () => {
    const { servico, prisma } = montar(adminDaC1);

    const resultado = await servico.atualizarStatusEmMassa('eu', {
      eventIds: ['e1', 'e2', 'e3', 'sumiu'],
      status: EventStatus.INACTIVE,
    });

    expect(prisma.event.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['e1', 'e2'] } },
      data: { status: EventStatus.INACTIVE },
    });
    expect(resultado.atualizados).toBe(2);
    expect(resultado.falhas).toEqual([
      {
        eventId: 'e3',
        nome: 'Da vizinha',
        motivo: 'Você não administra a igreja deste evento',
      },
      { eventId: 'sumiu', nome: null, motivo: 'Evento não encontrado' },
    ]);
  });

  it('financeiro da igreja não muda status', async () => {
    const { servico, prisma } = montar({
      role: Role.FINANCE,
      churchRoles: [{ role: Role.FINANCE, churchId: 'c1' }],
    });

    const resultado = await servico.atualizarStatusEmMassa('eu', {
      eventIds: ['e1'],
      status: EventStatus.INACTIVE,
    });

    expect(prisma.event.updateMany).not.toHaveBeenCalled();
    expect(resultado).toEqual({
      atualizados: 0,
      falhas: [expect.objectContaining({ eventId: 'e1' })],
    });
  });

  it('super admin muda de qualquer igreja', async () => {
    const { servico } = montar({ role: Role.SUPER_ADMIN, churchRoles: [] });

    const resultado = await servico.atualizarStatusEmMassa('eu', {
      eventIds: ['e1', 'e3'],
      status: EventStatus.TEST,
    });

    expect(resultado).toEqual({ atualizados: 2, falhas: [] });
  });
});
