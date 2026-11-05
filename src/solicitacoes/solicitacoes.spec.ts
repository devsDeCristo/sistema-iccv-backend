import { ChurchModule } from '@prisma/client';
import { SolicitacoesService } from './solicitacoes.service';

/** O banco de mentira: uma igreja, um membro dela e uma solicitação */
function montar({
  igrejaDoMembro = { id: 'igreja-1', status: 'ACTIVE' } as any,
  modulos = [ChurchModule.REQUESTS] as ChurchModule[],
} = {}) {
  const criadas: any[] = [];
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
    churchRequest: {
      create: jest.fn(async ({ data }: any) => {
        criadas.push(data);
        return data;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === 'sol-1' && where.churchId === 'igreja-1'
          ? { id: 'sol-1' }
          : null,
      ),
      update: jest.fn(async ({ data }: any) => data),
    },
  };
  return { service: new SolicitacoesService(prisma as any), criadas, prisma };
}

const pedido = {
  ministerio: 'Louvor',
  titulo: ' Pedestal ',
  descricao: 'Quebrou',
  link: 'https://loja.com.br/pedestal',
};

describe('SolicitacoesService', () => {
  it('pede para a igreja de que a pessoa é membro', async () => {
    const { service, criadas } = montar();
    await service.criar('u1', pedido);
    expect(criadas).toEqual([
      expect.objectContaining({
        churchId: 'igreja-1',
        requesterId: 'u1',
        title: 'Pedestal',
        link: 'https://loja.com.br/pedestal',
      }),
    ]);
  });

  it('quem não é membro de nenhuma igreja não pede', async () => {
    const { service, criadas } = montar({ igrejaDoMembro: null });
    await expect(service.criar('u1', pedido)).rejects.toMatchObject({
      status: 403,
    });
    expect(criadas).toEqual([]);
  });

  it('igreja sem Solicitações no plano não recebe pedido', async () => {
    const { service, criadas } = montar({ modulos: [ChurchModule.EVENTS] });
    await expect(service.criar('u1', pedido)).rejects.toMatchObject({
      status: 403,
    });
    expect(criadas).toEqual([]);
  });

  it('o admin não responde solicitação de outra igreja', async () => {
    const { service, prisma } = montar();
    await expect(
      service.mudarStatus('igreja-2', 'sol-1', { status: 'ACCEPTED' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.churchRequest.update).not.toHaveBeenCalled();
  });

  it('muda a situação e guarda a resposta', async () => {
    const { service } = montar();
    const feita = await service.mudarStatus('igreja-1', 'sol-1', {
      status: 'REJECTED',
      resposta: ' Sem verba este mês ',
    });
    expect(feita).toEqual({
      status: 'REJECTED',
      response: 'Sem verba este mês',
    });
  });
});
