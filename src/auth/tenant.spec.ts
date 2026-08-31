import { ForbiddenException } from '@nestjs/common';
import { Role } from './roles';
import {
  assertSameChurch,
  isTenantScoped,
  tenantChurchId,
  userChurchScope,
} from './tenant';

const admin = { role: Role.ADMIN, churchId: 'igreja-a' };
const finance = { role: Role.FINANCE, churchId: 'igreja-a' };
const superAdmin = { role: Role.SUPER_ADMIN, churchId: null };
// usuário comum não pertence a igreja nenhuma: se inscreve em evento de
// qualquer uma e é a inscrição que o mostra para aquele painel
const comum = { role: Role.USER, churchId: null };

describe('isTenantScoped', () => {
  it('recorta admin e financeiro', () => {
    expect(isTenantScoped(Role.ADMIN)).toBe(true);
    expect(isTenantScoped(Role.FINANCE)).toBe(true);
  });

  it('não recorta super admin nem usuário comum', () => {
    // o super admin atravessa as igrejas; o usuário comum se inscreve em
    // evento de qualquer uma
    expect(isTenantScoped(Role.SUPER_ADMIN)).toBe(false);
    expect(isTenantScoped(Role.USER)).toBe(false);
    expect(isTenantScoped(null)).toBe(false);
  });
});

describe('tenantChurchId', () => {
  it('devolve a igreja de quem é recortado', () => {
    expect(tenantChurchId(admin)).toBe('igreja-a');
    expect(tenantChurchId(finance)).toBe('igreja-a');
  });

  it('devolve null para quem atravessa o recorte', () => {
    expect(tenantChurchId(superAdmin)).toBeNull();
    expect(tenantChurchId(comum)).toBeNull();
    expect(tenantChurchId(null)).toBeNull();
  });

  it('não recorta usuário comum nem se ele tiver igreja gravada', () => {
    // vínculo antigo de antes da regra não pode virar filtro no catálogo
    expect(tenantChurchId({ role: Role.USER, churchId: 'igreja-a' })).toBeNull();
  });

  it('falha fechado quando o admin está sem igreja', () => {
    // o contrário — devolver null — daria a ele acesso de super admin
    expect(() => tenantChurchId({ role: Role.ADMIN, churchId: null })).toThrow(
      ForbiddenException,
    );
  });
});

describe('assertSameChurch', () => {
  it('deixa passar recurso da própria igreja', () => {
    expect(() => assertSameChurch(admin, 'igreja-a')).not.toThrow();
  });

  it('barra recurso de outra igreja', () => {
    expect(() => assertSameChurch(admin, 'igreja-b')).toThrow(
      ForbiddenException,
    );
  });

  it('não barra o super admin', () => {
    expect(() => assertSameChurch(superAdmin, 'igreja-b')).not.toThrow();
  });
});

describe('userChurchScope', () => {
  it('alcança o pessoal do painel e quem participa dos eventos da igreja', () => {
    expect(userChurchScope(admin)).toEqual({
      OR: [
        { churchId: 'igreja-a' },
        { events: { some: { event: { churchId: 'igreja-a' } } } },
        { waitlists: { some: { event: { churchId: 'igreja-a' } } } },
      ],
    });
  });

  it('não filtra nada para o super admin', () => {
    expect(userChurchScope(superAdmin)).toEqual({});
  });
});
