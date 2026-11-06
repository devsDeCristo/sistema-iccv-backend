import { Role } from 'src/auth/roles';
import { NotificacoesService } from './notificacoes.service';
import {
  notificarEvento,
  notificarNoticia,
  notificarPedidoDeMembro,
  notificarRespostaDaSolicitacao,
  notificarSolicitacao,
} from './notificar';

function montar({
  jaExiste = false,
  eventId = null as string | null,
  status = 'ACCEPTED',
  statusDoEvento = 'ACTIVE',
  autorId = null as string | null,
} = {}) {
  const criadas: any[] = [];
  const prisma = {
    notification: {
      findUnique: jest.fn(async () => (jaExiste ? { id: 'x' } : null)),
      create: jest.fn(async ({ data }: any) => criadas.push(data)),
    },
    userChurchRole: {
      findMany: jest.fn(async ({ where }: any) =>
        where.role === Role.ADMIN ? [{ userId: 'admin-1' }] : [],
      ),
    },
    user: {
      findUnique: jest.fn(async () => ({ fullName: 'Ana' })),
      findMany: jest.fn(async () => [{ id: 'm1' }, { id: 'm2' }]),
    },
    church: { findUnique: jest.fn(async () => ({ name: 'Igreja Um' })) },
    churchRequest: {
      findUnique: jest.fn(async () => ({
        title: 'Microfone',
        churchId: 'ig1',
        status,
        response: null,
        requesterId: 'bia',
        requester: { fullName: 'Bia' },
      })),
    },
    news: {
      findUnique: jest.fn(async () => ({
        title: 'Culto',
        summary: null,
        churchId: 'ig1',
        eventId,
        authorId: autorId,
        church: { name: 'Igreja Um' },
      })),
    },
    event: {
      findUnique: jest.fn(async () => ({
        name: 'Retiro',
        status: statusDoEvento,
        churchId: 'ig1',
      })),
    },
  };
  const destinatarios = () =>
    criadas.map((c) => c.recipients.createMany.data.map((r: any) => r.userId));
  return { prisma: prisma as any, criadas, destinatarios };
}

describe('notificar', () => {
  it('pedido de membro e solicitação vão só para os admins da igreja', async () => {
    const { prisma, criadas, destinatarios } = montar();
    await notificarPedidoDeMembro(prisma, 'u1', 'ig1');
    await notificarSolicitacao(prisma, 's1');
    expect(criadas.map((c) => c.type)).toEqual([
      'MEMBERSHIP_REQUEST',
      'CHURCH_REQUEST',
    ]);
    expect(destinatarios()).toEqual([['admin-1'], ['admin-1']]);
    expect(prisma.userChurchRole.findMany.mock.calls[0][0].where).toEqual({
      churchId: 'ig1',
      role: Role.ADMIN,
    });
  });

  it('notícia vai para os membros; com evento, só os que estão nele', async () => {
    const { prisma, destinatarios } = montar({ eventId: 'ev1' });
    await notificarNoticia(prisma, 'n1');
    expect(destinatarios()).toEqual([['m1', 'm2']]);
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.memberChurchId).toBe('ig1');
    expect(where.OR).toHaveLength(2);
  });

  it('quem fez a ação não recebe o próprio aviso', async () => {
    const { prisma, destinatarios } = montar({ autorId: 'm1' });
    await notificarNoticia(prisma, 'n1');
    expect(destinatarios()).toEqual([['m2']]);
  });

  it('resposta da solicitação vai para quem pediu, uma vez por situação', async () => {
    const { prisma, criadas, destinatarios } = montar({ status: 'REJECTED' });
    await notificarRespostaDaSolicitacao(prisma, 's1', 'admin-1');
    expect(criadas[0].sourceId).toBe('s1:REJECTED');
    expect(criadas[0].title).toBe('Solicitação recusada');
    expect(destinatarios()).toEqual([['bia']]);
  });

  it('voltar para solicitada não avisa', async () => {
    const { prisma, criadas } = montar({ status: 'REQUESTED' });
    await notificarRespostaDaSolicitacao(prisma, 's1');
    expect(criadas).toHaveLength(0);
  });

  it('evento só avisa aberto ao público, e sem quem o abriu', async () => {
    const teste = montar({ statusDoEvento: 'TEST' });
    await notificarEvento(teste.prisma, 'e1');
    expect(teste.criadas).toHaveLength(0);

    const ativo = montar();
    await notificarEvento(ativo.prisma, 'e1', 'm1');
    expect(ativo.criadas[0].sourceId).toBe('e1');
    expect(ativo.destinatarios()).toEqual([['m2']]);
  });

  it('a mesma origem notifica uma vez só', async () => {
    const { prisma, criadas } = montar({ jaExiste: true });
    await notificarNoticia(prisma, 'n1');
    expect(criadas).toHaveLength(0);
  });

  it('erro no aviso não derruba quem chamou', async () => {
    const { prisma } = montar();
    prisma.notification.create = jest.fn(async () => {
      throw new Error('banco fora');
    });
    await expect(notificarSolicitacao(prisma, 's1')).resolves.toBeUndefined();
  });
});

describe('NotificacoesService.marcarLidas', () => {
  it('só mexe nas da própria pessoa; sem ids, em todas as não lidas', async () => {
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const service = new NotificacoesService({
      notificationRecipient: { updateMany },
    } as any);
    await service.marcarLidas('u1', ['a']);
    await service.marcarLidas('u1');
    expect((updateMany.mock.calls as any[])[0][0].where).toEqual({
      userId: 'u1',
      readAt: null,
      notificationId: { in: ['a'] },
    });
    expect((updateMany.mock.calls as any[])[1][0].where).toEqual({
      userId: 'u1',
      readAt: null,
    });
  });
});
