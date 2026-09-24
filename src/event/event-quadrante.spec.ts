import {
  normalizarMostrarQuadrante,
  quadranteAtivo,
} from './event-quadrante';

describe('quadranteAtivo', () => {
  it('fica fechado em evento sem a chave', () => {
    expect(quadranteAtivo({})).toBe(false);
    expect(quadranteAtivo(null)).toBe(false);
  });

  it('abre só com true', () => {
    expect(quadranteAtivo({ showQuadrante: true })).toBe(true);
    expect(quadranteAtivo({ showQuadrante: 'true' })).toBe(false);
  });

  it('fica fechado com o módulo de equipes desligado', () => {
    expect(
      quadranteAtivo({
        showQuadrante: true,
        modules: { teams: false },
      }),
    ).toBe(false);
  });
});

describe('normalizarMostrarQuadrante', () => {
  it('converte qualquer coisa que não seja true em false', () => {
    expect(normalizarMostrarQuadrante(true)).toBe(true);
    expect(normalizarMostrarQuadrante('sim')).toBe(false);
    expect(normalizarMostrarQuadrante(1)).toBe(false);
    expect(normalizarMostrarQuadrante(undefined)).toBe(false);
  });
});
