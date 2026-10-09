import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { NewsService } from './news.service';

/**
 * Multitenant das notícias. O caso que importa é o admin de duas igrejas: as
 * regras comparam com a igreja **da notícia**, não com "alguma igreja que ele
 * administra".
 */
const adminDeAeB = {
  role: Role.ADMIN,
  churchRoles: [
    { churchId: 'A', role: Role.ADMIN },
    { churchId: 'B', role: Role.ADMIN },
  ],
};

function montar({
  grupos = 0,
  igrejaDoEvento = 'A',
}: { grupos?: number; igrejaDoEvento?: string } = {}) {
  const prisma = {
    groupRoles: { count: jest.fn().mockResolvedValue(grupos) },
    event: {
      findUnique: jest.fn().mockResolvedValue({ churchId: igrejaDoEvento }),
    },
  };
  return {
    service: new NewsService(prisma as any, {} as any) as any,
    prisma,
  };
}

describe('NewsService — igreja da notícia', () => {
  it('quem administra duas escolhe a igreja', async () => {
    const { service } = montar();
    await expect(
      service.igrejaDaPublicacao(adminDeAeB, null, 'B'),
    ).resolves.toBe('B');
  });

  it('não escolhe igreja que não administra', async () => {
    const { service } = montar();
    await expect(
      service.igrejaDaPublicacao(adminDeAeB, null, 'C'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sem escolha, vale a do evento do público', async () => {
    const { service } = montar({ igrejaDoEvento: 'B' });
    await expect(service.igrejaDaPublicacao(adminDeAeB, 'ev1')).resolves.toBe(
      'B',
    );
  });
});

describe('NewsService — destinos e público da igreja da notícia', () => {
  it('grupo de evento da outra igreja do mesmo admin é recusado', async () => {
    // dos dois grupos pedidos, só um é da igreja A
    const { service, prisma } = montar({ grupos: 1 });

    await expect(
      service.assertDestinosDaIgreja('A', ['g-de-A', 'g-de-B']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.groupRoles.count).toHaveBeenCalledWith({
      where: { id: { in: ['g-de-A', 'g-de-B'] }, event: { churchId: 'A' } },
    });
  });

  it('notícia sem igreja não aceita destino de WhatsApp', async () => {
    const { service } = montar();
    await expect(
      service.assertDestinosDaIgreja(null, [], ['https://chat.whatsapp.com/x']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('evento do público de outra igreja é recusado', async () => {
    const { service } = montar({ igrejaDoEvento: 'B' });
    await expect(
      service.assertEventoDaIgreja('ev1', 'A'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('NewsService — recorte das telas por igreja', () => {
  it('a igreja do seletor precisa ser uma que a pessoa administra', () => {
    const { service } = montar();
    expect(service.recorteDaIgreja(adminDeAeB, 'B')).toEqual({ churchId: 'B' });
    expect(() => service.recorteDaIgreja(adminDeAeB, 'C')).toThrow(
      ForbiddenException,
    );
  });

  it('super admin escolhe qualquer igreja', () => {
    const { service } = montar();
    expect(
      service.recorteDaIgreja({ role: Role.SUPER_ADMIN, churchRoles: [] }, 'C'),
    ).toEqual({ churchId: 'C' });
  });
});

describe('NewsService — trocar a igreja na edição', () => {
  const editar = (churchId: string, grupos: number) => {
    const prisma = {
      news: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'n1', churchId: 'A', eventId: null }),
      },
      user: { findUnique: jest.fn().mockResolvedValue(adminDeAeB) },
      groupRoles: { count: jest.fn().mockResolvedValue(grupos) },
    };
    const service = new NewsService(prisma as any, {} as any);
    return service.update(
      'n1',
      {
        title: 'x',
        content: '<p>x</p>',
        isPublished: false,
        eventId: null,
        churchId,
        groupRoleIds: ['g-de-A'],
      },
      'u1',
    );
  };

  it('não troca para igreja que não administra', async () => {
    await expect(editar('C', 0)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('trocando para B, os grupos da igreja A são recusados', async () => {
    await expect(editar('B', 0)).rejects.toBeInstanceOf(BadRequestException);
  });
});
