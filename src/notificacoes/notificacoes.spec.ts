import { Logger } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { MembrosService } from 'src/membros/membros.service';
import { NotificacoesService } from './notificacoes.service';
import {
  encerrarPedidoDeMembro,
  notificarEvento,
  notificarEventosDaIgreja,
  notificarNoticia,
  notificarPedidoDeMembro,
  notificarRespostaDaSolicitacao,
  notificarSolicitacao,
  notificarVezNaSolicitacao,
} from './notificar';

function montar({
  jaExiste = false,
  eventId = null as string | null,
  status = 'ACCEPTED',
  statusDoEvento = 'ACTIVE',
  statusDaIgreja = 'ACTIVE',
  autorId = null as string | null,
} = {}) {
  const criadas: any[] = [];
  const prisma = {
    notification: {
      // a origem repetida bate no índice único, como no banco
      create: jest.fn(async ({ data }: any) => {
        if (jaExiste)
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        criadas.push(data);
      }),
    },
    notificationRecipient: { deleteMany: jest.fn() },
    userChurchRole: {
      // um admin e uma tesouraria na igreja; devolve os dos perfis pedidos
      findMany: jest.fn(async ({ where }: any) =>
        [
          { userId: 'admin-1', role: Role.ADMIN },
          { userId: 'tes-1', role: Role.TESOURARIA },
        ].filter((v) => where.role.in.includes(v.role)),
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
        church: { spiritualLeaderId: 'pastor-1' },
      })),
    },
    news: {
      findUnique: jest.fn(async () => ({
        title: 'Culto',
        summary: null,
        publishedAt: new Date(1000),
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
        church: { status: statusDaIgreja },
      })),
      findMany: jest.fn(async () => [{ id: 'e1' }, { id: 'e2' }]),
    },
  };
  const destinatarios = () =>
    criadas.map((c) => c.recipients.createMany.data.map((r: any) => r.userId));
  return { prisma: prisma as any, criadas, destinatarios };
}

describe('notificar', () => {
  it('pedido de membro vai só para os admins da igreja', async () => {
    const { prisma, criadas, destinatarios } = montar();
    await notificarPedidoDeMembro(prisma, 'u1', 'ig1');
    expect(criadas.map((c) => c.type)).toEqual(['MEMBERSHIP_REQUEST']);
    expect(destinatarios()).toEqual([['admin-1']]);
    expect(prisma.userChurchRole.findMany.mock.calls[0][0].where).toEqual({
      churchId: 'ig1',
      role: { in: [Role.ADMIN] },
    });
  });

  it('solicitação nova vai para os admins e a tesouraria da igreja', async () => {
    const { prisma, criadas, destinatarios } = montar();
    await notificarSolicitacao(prisma, 's1');
    expect(criadas.map((c) => c.type)).toEqual(['CHURCH_REQUEST']);
    expect(destinatarios()).toEqual([['admin-1', 'tes-1']]);
  });

  it('notícia vai para os membros da igreja', async () => {
    const { prisma, criadas } = montar();
    await notificarNoticia(prisma, 'n1');
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
      memberChurchId: 'ig1',
    });
    // uma vez por publicação: o disparo agendado seguinte avisa de novo
    expect(criadas[0].sourceId).toBe('n1:1000');
  });

  it('notícia de evento vai para quem está nele, de qualquer igreja', async () => {
    const { prisma, destinatarios } = montar({ eventId: 'ev1' });
    await notificarNoticia(prisma, 'n1');
    expect(destinatarios()).toEqual([['m1', 'm2']]);
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.memberChurchId).toBeUndefined();
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

  it('o pastor aprovou: avisa a tesouraria da igreja que é a vez dela', async () => {
    const { prisma, criadas, destinatarios } = montar({
      status: 'AWAITING_TREASURY',
    });
    await notificarVezNaSolicitacao(prisma, 's1', 'pastor-1');
    expect(criadas[0]).toMatchObject({
      type: 'CHURCH_REQUEST_AWAITING',
      sourceId: 's1:AWAITING_TREASURY',
      title: 'Solicitação aguardando a tesouraria',
    });
    expect(destinatarios()).toEqual([['tes-1']]);
  });

  it('a tesouraria aprovou: avisa o pastor', async () => {
    const { prisma, criadas, destinatarios } = montar({
      status: 'AWAITING_PASTOR',
    });
    await notificarVezNaSolicitacao(prisma, 's1', 'tes-1');
    expect(criadas[0].title).toBe('Solicitação aguardando o pastor');
    expect(destinatarios()).toEqual([['pastor-1']]);
  });

  it('fora do "aguardando", ninguém tem vez a avisar', async () => {
    const { prisma, criadas } = montar({ status: 'ACCEPTED' });
    await notificarVezNaSolicitacao(prisma, 's1');
    expect(criadas).toHaveLength(0);
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

  it('evento de igreja em implantação espera a igreja sair do teste', async () => {
    const { prisma, criadas } = montar({ statusDaIgreja: 'TEST' });
    await notificarEvento(prisma, 'e1');
    expect(criadas).toHaveLength(0);

    const saiu = montar();
    await notificarEventosDaIgreja(saiu.prisma, 'ig1');
    expect(saiu.prisma.event.findMany.mock.calls[0][0].where).toMatchObject({
      churchId: 'ig1',
      status: 'ACTIVE',
    });
    expect(saiu.criadas.map((c) => c.sourceId)).toEqual(['e1', 'e2']);
  });

  it('a mesma origem notifica uma vez só, sem virar erro no log', async () => {
    const { prisma, criadas } = montar({ jaExiste: true });
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await notificarNoticia(prisma, 'n1');
    expect(criadas).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('o fim do pedido tira o aviso do sininho dos admins', async () => {
    const { prisma } = montar();
    await encerrarPedidoDeMembro(prisma, 'u1');
    expect(prisma.notificationRecipient.deleteMany).toHaveBeenCalledWith({
      where: {
        notification: { type: 'MEMBERSHIP_REQUEST', sourceId: 'u1' },
      },
    });
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

describe('MembrosService.tornarMembro', () => {
  function servico(requestedChurchId: string | null) {
    const { prisma, criadas } = montar();
    prisma.user.findUnique = jest.fn(async () => ({
      requestedChurchId,
      fullName: 'Ana',
    }));
    prisma.user.updateMany = jest.fn(async () => ({ count: 1 }));
    return { service: new MembrosService(prisma), prisma, criadas };
  }

  it('por qualquer caminho, quem tinha pedido esta igreja fica sabendo', async () => {
    const { service, prisma, criadas } = servico('ig1');
    await service.tornarMembro('ig1', 'u1', 'admin-1');
    expect(criadas.map((c) => c.type)).toEqual(['MEMBERSHIP_ANSWERED']);
    expect(prisma.notificationRecipient.deleteMany).toHaveBeenCalled();
  });

  it('pedido para outra igreja só some do sininho de lá', async () => {
    const { service, prisma, criadas } = servico('ig2');
    await service.tornarMembro('ig1', 'u1');
    expect(criadas).toHaveLength(0);
    expect(prisma.notificationRecipient.deleteMany).toHaveBeenCalled();
  });

  it('sem pedido, nada muda no sininho', async () => {
    const { service, prisma, criadas } = servico(null);
    await service.tornarMembro('ig1', 'u1');
    expect(criadas).toHaveLength(0);
    expect(prisma.notificationRecipient.deleteMany).not.toHaveBeenCalled();
  });
});
