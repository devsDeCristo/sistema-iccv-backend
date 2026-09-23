import {
  normalizarMostrarQuadrante,
  quadranteVisivelParaInscritos,
} from './event-quadrante';

describe('quadranteVisivelParaInscritos', () => {
  it('fica fechado em evento sem a chave', () => {
    expect(quadranteVisivelParaInscritos({})).toBe(false);
    expect(quadranteVisivelParaInscritos(null)).toBe(false);
  });

  it('abre só com true', () => {
    expect(quadranteVisivelParaInscritos({ showQuadrante: true })).toBe(true);
    expect(quadranteVisivelParaInscritos({ showQuadrante: 'true' })).toBe(false);
  });

  it('fica fechado com o módulo de equipes desligado', () => {
    expect(
      quadranteVisivelParaInscritos({
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
