import { Role } from './roles';
import { podeBloquear } from './bloqueio';

const pessoa = (id: string, role: Role) => ({ id, role });

describe('podeBloquear', () => {
  it('super admin bloqueia admin, tesouraria e usuário', () => {
    const sa = pessoa('sa', Role.SUPER_ADMIN);
    expect(podeBloquear(sa, pessoa('a', Role.ADMIN))).toBe(true);
    expect(podeBloquear(sa, pessoa('t', Role.TESOURARIA))).toBe(true);
    expect(podeBloquear(sa, pessoa('u', Role.USER))).toBe(true);
  });

  it('ninguém bloqueia a si mesmo', () => {
    expect(podeBloquear(pessoa('d', Role.DEV), pessoa('d', Role.DEV))).toBe(
      false,
    );
  });

  it('super admin e dev só um dev bloqueia', () => {
    const sa = pessoa('sa', Role.SUPER_ADMIN);
    expect(podeBloquear(sa, pessoa('sa2', Role.SUPER_ADMIN))).toBe(false);
    expect(podeBloquear(sa, pessoa('d', Role.DEV))).toBe(false);
    const dev = pessoa('d', Role.DEV);
    expect(podeBloquear(dev, pessoa('sa', Role.SUPER_ADMIN))).toBe(true);
    expect(podeBloquear(dev, pessoa('d2', Role.DEV))).toBe(true);
  });

  it('quem não é super admin não bloqueia ninguém', () => {
    expect(podeBloquear(pessoa('a', Role.ADMIN), pessoa('u', Role.USER))).toBe(
      false,
    );
  });
});
