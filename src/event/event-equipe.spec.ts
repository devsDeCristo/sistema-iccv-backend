import { BadRequestException } from '@nestjs/common';
import { Role } from 'src/auth/roles';
import { EventService } from './event.service';

/**
 * A equipe do evento (admins e tesoureiros) pode ser qualquer usuário, membro
 * ou não — só não entra quem já vê o evento todo pelo perfil na igreja.
 */
const PESSOAS = [
  { id: 'qualquer', fullName: 'Qualquer', role: Role.USER, churchRoles: [] },
  {
    id: 'admin',
    fullName: 'Admin',
    role: Role.ADMIN,
    churchRoles: [{ churchId: 'A', role: Role.ADMIN }],
  },
  {
    id: 'tesouraria',
    fullName: 'Tesouraria',
    role: Role.TESOURARIA,
    churchRoles: [{ churchId: 'A', role: Role.TESOURARIA }],
  },
];

const servico = () =>
  new EventService(
    {
      user: {
        findMany: async ({ where }: any) =>
          PESSOAS.filter((p) => where.id.in.includes(p.id)),
      },
    } as any,
    {} as any,
    {} as any,
  ) as any;

describe('EventService — equipe do evento', () => {
  it('aceita qualquer usuário, membro ou não', async () => {
    await expect(
      servico().validarEquipe('A', {
        adminIds: ['qualquer'],
        tesoureiros: [{ userId: 'qualquer', kind: 'BASICO' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('recusa o admin da igreja como admin do evento', async () => {
    await expect(
      servico().validarEquipe('A', { adminIds: ['admin'] }),
    ).rejects.toThrow('Admin já é admin da igreja do evento');
  });

  it('recusa a tesouraria da igreja como tesoureira, mas não como admin', async () => {
    await expect(
      servico().validarEquipe('A', {
        tesoureiros: [{ userId: 'tesouraria', kind: 'COMPLETO' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      servico().validarEquipe('A', { adminIds: ['tesouraria'] }),
    ).resolves.toBeUndefined();
  });

  it('recusa quem não existe e quem aparece duas vezes', async () => {
    await expect(
      servico().validarEquipe('A', { adminIds: ['sumiu'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      servico().validarEquipe('A', { adminIds: ['qualquer', 'qualquer'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
