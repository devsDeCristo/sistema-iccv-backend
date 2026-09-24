import { codigoDoCracha, montarFolhas, qrDoCracha } from './cracha-pdf';

const ID = 'db062ca4-86cf-4295-b822-7c259b8e4983';

describe('crachá', () => {
  it('o QR leva o id em hex maiúsculo, sem hífen — o que o leitor espera', () => {
    expect(codigoDoCracha(ID)).toBe('DB062CA486CF4295B8227C259B8E4983');
  });

  it('id que não é uuid não vira QR', () => {
    expect(codigoDoCracha('abc')).toBe('');
    expect(qrDoCracha('abc')).toBeNull();
    expect(qrDoCracha(undefined)).toBeNull();
  });

  it('QR de 25 módulos mais 2 de margem de cada lado', () => {
    expect(qrDoCracha(ID)).toContain('viewBox="0 0 29 29"');
  });

  it('quatro por folha, cada seção em folha nova, em branco no fim', () => {
    const cracha = { nome: 'Fulano', qr: null };
    const folhas = montarFolhas(
      [
        { titulo: 'liturgia', crachas: Array(5).fill(cracha) },
        { titulo: 'cozinha', crachas: [cracha] },
      ],
      2,
    );

    expect(folhas.map((f) => [f.titulo, f.crachas.length])).toEqual([
      ['liturgia', 4],
      ['liturgia', 1],
      ['cozinha', 1],
      [null, 2],
    ]);
  });
});
