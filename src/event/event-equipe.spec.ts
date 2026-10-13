import { BadRequestException } from '@nestjs/common';
import { EventService } from './event.service';

/**
 * A equipe do evento (admins e tesoureiros) pode ser qualquer usuário, de
 * qualquer perfil — o vínculo só soma, e vale o maior. A recusa nunca conta o
 * perfil de ninguém: só quem não existe e quem se repete.
 */
const EXISTEM = ['qualquer', 'super-admin', 'admin-da-igreja'];

const servico = () =>
  new EventService(
    {
      user: {
        count: async ({ where }: any) =>
          where.id.in.filter((id: string) => EXISTEM.includes(id)).length,
      },
    } as any,
    {} as any,
    {} as any,
  ) as any;

describe('EventService — equipe do evento', () => {
  it('aceita qualquer usuário, de qualquer perfil', async () => {
    await expect(
      servico().validarEquipe({
        adminIds: ['qualquer', 'super-admin', 'admin-da-igreja'],
        tesoureiros: [{ userId: 'admin-da-igreja', kind: 'BASICO' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('recusa quem não existe e quem aparece duas vezes, sem dizer perfil', async () => {
    await expect(
      servico().validarEquipe({ adminIds: ['sumiu'] }),
    ).rejects.toThrow('Pessoa da equipe do evento não encontrada');
    await expect(
      servico().validarEquipe({ adminIds: ['qualquer', 'qualquer'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
