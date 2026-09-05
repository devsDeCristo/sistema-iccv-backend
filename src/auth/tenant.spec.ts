import { ForbiddenException } from '@nestjs/common';
import { ADMIN_AREA_ROLES, Role } from './roles';
import {
  assertChurchAccess,
  churchIdsComPerfil,
  perfilNaIgreja,
  tenantChurchIds,
  userChurchScope,
} from './tenant';

const IGREJA_A = 'igreja-a';
const IGREJA_B = 'igreja-b';

/** admin numa igreja e financeiro na outra: o caso que o modelo existe para atender */
const doisChapeus = {
  role: Role.ADMIN,
  churchRoles: [
    { churchId: IGREJA_A, role: Role.ADMIN },
    { churchId: IGREJA_B, role: Role.FINANCE },
  ],
};

const adminDeA = {
  role: Role.ADMIN,
  churchRoles: [{ churchId: IGREJA_A, role: Role.ADMIN }],
};

const superAdmin = { role: Role.SUPER_ADMIN, churchRoles: [] };
const inscrito = { role: Role.USER, churchRoles: [] };

describe('churchIdsComPerfil', () => {
  it('separa onde a pessoa é admin de onde ela é financeiro', () => {
    expect(churchIdsComPerfil(doisChapeus, [Role.ADMIN])).toEqual([IGREJA_A]);
    expect(churchIdsComPerfil(doisChapeus, [Role.FINANCE])).toEqual([IGREJA_B]);
    expect(churchIdsComPerfil(doisChapeus, ADMIN_AREA_ROLES)).toEqual([
      IGREJA_A,
      IGREJA_B,
    ]);
  });
});

describe('perfilNaIgreja', () => {
  it('devolve o perfil daquela igreja, não o mais alto', () => {
    expect(perfilNaIgreja(doisChapeus, IGREJA_A)).toBe(Role.ADMIN);
    expect(perfilNaIgreja(doisChapeus, IGREJA_B)).toBe(Role.FINANCE);
  });

  it('devolve null onde ela não administra', () => {
    expect(perfilNaIgreja(adminDeA, IGREJA_B)).toBeNull();
  });
});

describe('tenantChurchIds', () => {
  it('não recorta o super admin nem o inscrito', () => {
    expect(tenantChurchIds(superAdmin)).toBeNull();
    expect(tenantChurchIds(inscrito)).toBeNull();
    expect(tenantChurchIds(null)).toBeNull();
  });

  it('lista vazia quando o perfil pedido ela não tem em lugar nenhum', () => {
    // vazio é "nenhuma igreja", e não "todas": o recorte falha fechado
    expect(tenantChurchIds(adminDeA, [Role.FINANCE])).toEqual([]);
  });

  it('não abre tudo para perfil de painel que ficou sem vínculo', () => {
    // igreja apagada, vínculo removido pela metade: alcança nada, não tudo
    expect(tenantChurchIds({ role: Role.ADMIN, churchRoles: [] })).toEqual([]);
  });
});

describe('assertChurchAccess', () => {
  it('deixa passar na igreja onde ela tem o perfil pedido', () => {
    expect(() =>
      assertChurchAccess(doisChapeus, IGREJA_A, { roles: [Role.ADMIN] }),
    ).not.toThrow();
  });

  it('barra o perfil de uma igreja de valer na outra', () => {
    // é financeiro na B: administrar a B continua fora de alcance
    expect(() =>
      assertChurchAccess(doisChapeus, IGREJA_B, { roles: [Role.ADMIN] }),
    ).toThrow(ForbiddenException);
  });

  it('aceita o financeiro onde a rota admite financeiro', () => {
    expect(() =>
      assertChurchAccess(doisChapeus, IGREJA_B, { roles: ADMIN_AREA_ROLES }),
    ).not.toThrow();
  });

  it('não barra o super admin', () => {
    expect(() => assertChurchAccess(superAdmin, IGREJA_B)).not.toThrow();
  });
});

describe('userChurchScope', () => {
  it('alcança quem administra as igrejas e quem participa dos eventos delas', () => {
    expect(userChurchScope(doisChapeus)).toEqual({
      OR: [
        { churchRoles: { some: { churchId: { in: [IGREJA_A, IGREJA_B] } } } },
        {
          events: {
            some: { event: { churchId: { in: [IGREJA_A, IGREJA_B] } } },
          },
        },
        {
          waitlists: {
            some: { event: { churchId: { in: [IGREJA_A, IGREJA_B] } } },
          },
        },
      ],
    });
  });

  it('não filtra nada para o super admin', () => {
    expect(userChurchScope(superAdmin)).toEqual({});
  });
});
