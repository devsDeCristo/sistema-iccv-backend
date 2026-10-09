import { BadRequestException } from '@nestjs/common';
import { NewsService, normalizaLinks } from './news.service';

describe('normalizaLinks', () => {
  it('padroniza o link e junta o mesmo grupo colado de jeitos diferentes', () => {
    expect(
      normalizaLinks([
        'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQr?mode=gi_t',
        ' https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQr ',
        'https://chat.whatsapp.com/invite/ZyXwVuTsRqPoNmLk1',
      ]),
    ).toEqual([
      'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQr',
      'https://chat.whatsapp.com/ZyXwVuTsRqPoNmLk1',
    ]);
  });

  it('ausente não mexe; vazio remove todos', () => {
    expect(normalizaLinks(undefined)).toBeUndefined();
    expect(normalizaLinks([])).toEqual([]);
  });

  it('recusa o que não é link de grupo', () => {
    expect(() => normalizaLinks(['https://google.com'])).toThrow(
      BadRequestException,
    );
  });
});

describe('NewsService — disparo para link avulso', () => {
  it('envia para o grupo do link e anota o resultado nele', async () => {
    const prisma = {
      news: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'n1',
          title: 'Aviso',
          content: '<p>Oi</p>',
          churchId: 'c1',
          imageUrl: null,
          groups: [],
          groupLinks: [
            {
              id: 'l1',
              link: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQr',
              sentAt: null,
            },
          ],
        }),
      },
      newsGroupLink: { update: jest.fn() },
      newsDispatch: { create: jest.fn() },
    };
    const whatsapp = {
      resolveGroupIdFromInvite: jest.fn().mockResolvedValue('123@g.us'),
      sendToGroup: jest.fn(),
    };
    const service = new NewsService(prisma as any, whatsapp as any);

    const resultado = await (service as any).disparaNoWhatsapp('n1', 'MANUAL');

    expect(resultado).toEqual({ enviados: 1, falhas: 0, semLink: 0 });
    expect(whatsapp.sendToGroup).toHaveBeenCalledWith(
      'c1',
      '123@g.us',
      expect.any(String),
      null,
    );
    expect(prisma.newsGroupLink.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { sentAt: expect.any(Date), error: null },
    });
  });
});
