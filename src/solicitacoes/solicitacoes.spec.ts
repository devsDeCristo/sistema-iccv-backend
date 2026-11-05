import { ChurchModule } from '@prisma/client';
import { SolicitacoesService } from './solicitacoes.service';

const ITENS = ['item-a', 'item-b', 'item-c'];

/** O banco de mentira: uma igreja, um membro dela e uma solicitação de 3 produtos */
function montar({
  igrejaDoMembro = { id: 'igreja-1', status: 'ACTIVE' } as any,
  modulos = [ChurchModule.REQUESTS] as ChurchModule[],
} = {}) {
  const criadas: any[] = [];
  const decisoes: Record<string, boolean | null> = {};
  const tx = {
    churchRequestItem: {
      update: jest.fn(async ({ where, data }: any) => {
        decisoes[where.id] = data.accepted;
      }),
    },
    churchRequest: { update: jest.fn(async ({ data }: any) => data) },
  };
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
          ? { id: 'sol-1', items: ITENS.map((id) => ({ id })) }
          : null,
      ),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return {
    service: new SolicitacoesService(prisma as any),
    criadas,
    decisoes,
    tx,
  };
}

const pedido = {
  ministerio: 'Louvor',
  titulo: ' Microfones ',
  descricao: 'Quebraram',
  produtos: [
    {
      nome: ' Microfone sem fio ',
      quantidade: 2,
      link: 'https://loja.com/mic',
    },
    { nome: 'Cabo XLR', quantidade: 3 },
  ],
};

describe('SolicitacoesService', () => {
  it('pede para a igreja de que a pessoa é membro, com os produtos na ordem', async () => {
    const { service, criadas } = montar();
    await service.criar('u1', pedido);
    expect(criadas[0]).toMatchObject({
      churchId: 'igreja-1',
      requesterId: 'u1',
      title: 'Microfones',
    });
    expect(criadas[0].items.create).toEqual([
      {
        name: 'Microfone sem fio',
        quantity: 2,
        link: 'https://loja.com/mic',
        position: 0,
      },
      { name: 'Cabo XLR', quantity: 3, link: null, position: 1 },
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
    const { service, tx } = montar();
    await expect(
      service.mudarStatus('igreja-2', 'sol-1', { status: 'ACCEPTED' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(tx.churchRequest.update).not.toHaveBeenCalled();
  });

  it('recusada: nenhum produto aceito, e guarda a resposta', async () => {
    const { service, decisoes } = montar();
    const feita = await service.mudarStatus('igreja-1', 'sol-1', {
      status: 'REJECTED',
      resposta: ' Sem verba este mês ',
    });
    expect(feita).toEqual({
      status: 'REJECTED',
      response: 'Sem verba este mês',
    });
    expect(decisoes).toEqual({
      'item-a': false,
      'item-b': false,
      'item-c': false,
    });
  });

  it('aceita em parte: só os marcados', async () => {
    const { service, decisoes } = montar();
    await service.mudarStatus('igreja-1', 'sol-1', {
      status: 'PARTIALLY_ACCEPTED',
      produtosAceitos: ['item-a', 'item-c'],
    });
    expect(decisoes).toEqual({
      'item-a': true,
      'item-b': false,
      'item-c': true,
    });
  });

  it('aceita em parte com todos, nenhum ou produto de outro pedido: recusa', async () => {
    const { service, tx } = montar();
    for (const produtosAceitos of [[], ITENS, ['item-a', 'de-outro-pedido']]) {
      await expect(
        service.mudarStatus('igreja-1', 'sol-1', {
          status: 'PARTIALLY_ACCEPTED',
          produtosAceitos,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(tx.churchRequest.update).not.toHaveBeenCalled();
  });

  it('de volta a em análise: nenhum produto decidido', async () => {
    const { service, decisoes } = montar();
    await service.mudarStatus('igreja-1', 'sol-1', { status: 'IN_REVIEW' });
    expect(Object.values(decisoes)).toEqual([null, null, null]);
  });
});
