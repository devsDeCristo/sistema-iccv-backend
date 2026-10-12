import { ChurchStatus, EventStatus } from '@prisma/client';
import { Role } from 'src/auth/roles';
import {
  filtroDeEventoEmTeste,
  podeVerEventoEmTeste,
} from './event-visibility';

const IGREJA_A = 'igreja-a';
const IGREJA_B = 'igreja-b';

/** nem evento em teste, nem evento de igreja em teste (implantação) */
const SEM_ENSAIO = {
  status: { not: EventStatus.TEST },
  church: { status: { not: ChurchStatus.TEST } },
};

/** admin numa igreja e tesouraria na outra */
const doisChapeus = {
  role: Role.ADMIN,
  churchRoles: [
    { churchId: IGREJA_A, role: Role.ADMIN },
    { churchId: IGREJA_B, role: Role.TESOURARIA },
  ],
};

describe('filtroDeEventoEmTeste', () => {
  it('mostra o ensaio só na igreja que a pessoa administra', () => {
    // o perfil efetivo dela é admin, mas na B ela é tesouraria: o ensaio de lá
    // não é da conta dela
    expect(filtroDeEventoEmTeste(doisChapeus)).toEqual({
      OR: [SEM_ENSAIO, { churchId: { in: [IGREJA_A] } }],
    });
  });

  it('esconde o ensaio da tesouraria puro', () => {
    expect(
      filtroDeEventoEmTeste({
        role: Role.TESOURARIA,
        churchRoles: [{ churchId: IGREJA_B, role: Role.TESOURARIA }],
      }),
    ).toEqual(SEM_ENSAIO);
  });

  it('esconde o ensaio do inscrito e de quem não está logado', () => {
    expect(filtroDeEventoEmTeste({ role: Role.USER, churchRoles: [] })).toEqual(
      SEM_ENSAIO,
    );
    expect(filtroDeEventoEmTeste(null)).toEqual(SEM_ENSAIO);
  });

  it('esconde o ensaio de quem tem perfil de painel mas ficou sem vínculo', () => {
    expect(
      filtroDeEventoEmTeste({ role: Role.ADMIN, churchRoles: [] }),
    ).toEqual(SEM_ENSAIO);
  });

  it('não filtra nada para o super admin', () => {
    expect(
      filtroDeEventoEmTeste({ role: Role.SUPER_ADMIN, churchRoles: [] }),
    ).toEqual({});
  });
});

describe('podeVerEventoEmTeste', () => {
  it('libera o ensaio na igreja que a pessoa administra', () => {
    expect(podeVerEventoEmTeste(doisChapeus, IGREJA_A)).toBe(true);
  });

  it('barra o ensaio na igreja onde ela é só tesouraria', () => {
    // o perfil efetivo de admin vem da outra igreja e não vale aqui
    expect(podeVerEventoEmTeste(doisChapeus, IGREJA_B)).toBe(false);
  });

  it('libera o super admin em qualquer igreja', () => {
    expect(
      podeVerEventoEmTeste(
        { role: Role.SUPER_ADMIN, churchRoles: [] },
        IGREJA_B,
      ),
    ).toBe(true);
  });

  it('barra o inscrito e quem não está logado', () => {
    expect(
      podeVerEventoEmTeste({ role: Role.USER, churchRoles: [] }, IGREJA_A),
    ).toBe(false);
    expect(podeVerEventoEmTeste(null, IGREJA_A)).toBe(false);
  });
});
