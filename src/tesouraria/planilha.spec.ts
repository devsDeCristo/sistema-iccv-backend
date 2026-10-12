import {
  emComum,
  escolher,
  mesmaPalavra,
  normalizar,
  palavrasDaBusca,
} from './planilha';

const c = (
  id: string,
  fullName: string,
  memberChurchId: string | null = null,
) => ({ id, fullName, memberChurchId });

describe('planilha de dízimos', () => {
  it('normaliza acento, caixa e espaços', () => {
    expect(normalizar('  Francisco de Assis  JÚNIOR ')).toBe(
      'francisco de assis junior',
    );
  });

  it('busca pelas palavras sem acento e sem conectivo; uma palavra só não busca', () => {
    expect(palavrasDaBusca('Francisco dos Santos Júnior / Ana')).toEqual([
      'francisco',
      'santos',
      'junior',
    ]);
    expect(palavrasDaBusca('Edilma Maria da S. Medeiros')).toEqual([
      'edilma',
      'maria',
      'medeiros',
    ]);
    expect(palavrasDaBusca('DJALMA')).toBeNull();
    expect(palavrasDaBusca('-')).toBeNull();
  });

  it('conta palavra inteira em comum, ignorando acento', () => {
    expect(emComum('Miquéias Abnadabe Ferreira Sousa', 'Miqueias Sousa')).toBe(
      2,
    );
    expect(emComum('Ana Lima', 'Mariana Lima')).toBe(1);
  });

  it('aceita um erro de digitação em palavra de 4+ letras', () => {
    expect(mesmaPalavra('damares', 'damaris')).toBe(true);
    expect(mesmaPalavra('miqueias', 'miqueas')).toBe(true);
    expect(mesmaPalavra('sousa', 'souza')).toBe(true);
    expect(mesmaPalavra('ana', 'ina')).toBe(false);
    expect(mesmaPalavra('lima', 'lira')).toBe(true);
    expect(mesmaPalavra('silva', 'costa')).toBe(false);
    expect(mesmaPalavra('damares', 'damarisa')).toBe(false);
  });

  it('o caso da Eduarda: Dâmares × Dâmaris casa de cara, para conferir', () => {
    expect(
      escolher(
        'Eduarda Dâmares Lima Diogenes',
        [
          c('e', 'Eduarda Dâmaris Lima Diógenes'),
          c('m', 'Maressa Dâmaris Lima Diógenes Silva'),
        ],
        'ig',
      ),
    ).toEqual({ escolhido: 'e', exato: false });
  });

  it('sem ninguém cabendo, fica com o favorito claro de mesmo primeiro nome', () => {
    expect(
      escolher(
        'Antônia Holanda de Paiva Bento',
        [c('a', 'Antonia Holanda Bento Costa'), c('x', 'Maria Holanda Bento')],
        'ig',
      ),
    ).toEqual({ escolhido: 'a', exato: false });
    // empate: a pessoa escolhe
    expect(
      escolher(
        'Antônia Holanda de Paiva Bento',
        [
          c('a', 'Antonia Holanda Bento Costa'),
          c('b', 'Antonia Paiva Bento Lima'),
        ],
        'ig',
      ),
    ).toEqual({ escolhido: null, exato: false });
  });

  it('casa o mesmo nome ignorando acento e conectivo, e o casal pelo primeiro', () => {
    expect(
      escolher('Kleber Junior de Sousa', [c('k', 'Kleber Júnior Sousa')], 'ig'),
    ).toEqual({ escolhido: 'k', exato: true });
    expect(
      escolher(
        'Esdras Dantas / Etiene',
        [c('e', 'Esdras Dantas'), c('x', 'Esdras Dantas Filho')],
        'ig',
      ),
    ).toEqual({ escolhido: 'e', exato: true });
  });

  it('sem o mesmo nome, sugere quem cabe inteiro no outro nome, para conferir', () => {
    expect(
      escolher(
        'Miquéias Abnadabe Ferreira Sousa',
        [c('m', 'Miqueias Sousa'), c('o', 'Abnadabe Lima')],
        'ig',
      ),
    ).toEqual({ escolhido: 'm', exato: false });
    // dois que cabem: a pessoa escolhe
    expect(
      escolher(
        'Miquéias Abnadabe Ferreira Sousa',
        [c('m', 'Miqueias Sousa'), c('f', 'Miqueias Ferreira')],
        'ig',
      ),
    ).toEqual({ escolhido: null, exato: false });
    // 2 palavras em comum, mas sobra nome dos dois lados: não escolhe sozinho
    expect(
      escolher('Maria Ferreira Silva', [c('x', 'Maria Silva Costa')], 'ig'),
    ).toEqual({ escolhido: null, exato: false });
  });

  it('entre homônimos, fica com o membro desta igreja; sem desempate, ninguém', () => {
    expect(
      escolher(
        'Maria Silva',
        [c('a', 'Maria Silva'), c('b', 'Maria Silva', 'ig')],
        'ig',
      ),
    ).toEqual({ escolhido: 'b', exato: true });
    expect(
      escolher(
        'Maria Silva',
        [c('a', 'Maria Silva'), c('b', 'Maria Silva')],
        'ig',
      ),
    ).toEqual({ escolhido: null, exato: false });
  });

  it('não escolhe membro de outra igreja', () => {
    expect(
      escolher('Maria Silva', [c('a', 'Maria Silva', 'outra')], 'ig'),
    ).toEqual({ escolhido: null, exato: false });
  });
});
