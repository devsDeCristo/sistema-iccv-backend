import {
  modulosDesligados,
  modulosDoEvento,
  moduloAtivo,
  normalizarModulos,
} from './event-modules';

describe('módulos do evento', () => {
  it('evento antigo, sem a chave, tem tudo ligado', () => {
    expect(modulosDoEvento({ name: 'Retiro' })).toEqual({
      bedrooms: true,
      teams: true,
      transport: true,
    });
  });

  it('só o que está explicitamente em false fica desligado', () => {
    const data = { modules: { bedrooms: false } };

    expect(moduloAtivo(data, 'bedrooms')).toBe(false);
    expect(moduloAtivo(data, 'teams')).toBe(true);
    expect(moduloAtivo(data, 'transport')).toBe(true);
  });

  it('valor estranho no corpo da requisição não liga módulo por ser verdadeiro', () => {
    expect(normalizarModulos({ bedrooms: 'não', teams: 0 })).toEqual({
      bedrooms: true,
      teams: true,
      transport: true,
    });
  });

  it('chave desconhecida não entra na paleta de módulos', () => {
    expect(normalizarModulos({ bedrooms: false, financeiro: true })).toEqual({
      bedrooms: false,
      teams: true,
      transport: true,
    });
  });

  it('aponta só o que está saindo do ar nesta edição', () => {
    const atual = { modules: { bedrooms: true, teams: false } };

    expect(modulosDesligados(atual, { bedrooms: false, teams: false })).toEqual(
      ['bedrooms'],
    );
  });

  it('salvar sem mexer em módulos não desliga nada', () => {
    expect(
      modulosDesligados({ modules: { bedrooms: true } }, undefined),
    ).toEqual([]);
  });
});
