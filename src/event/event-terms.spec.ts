import {
  exigeAceiteDeTermo,
  idadeDoTermo,
  termoDeInscricao,
} from './event-terms';

describe('exigeAceiteDeTermo', () => {
  it('exige aceite quando o admin escreveu um termo', () => {
    expect(
      exigeAceiteDeTermo({
        registrationTerm: '<p>Autorizo o uso da minha imagem.</p>',
      }),
    ).toBe(true);
  });

  it('não exige nada do evento que nunca teve termo', () => {
    expect(
      exigeAceiteDeTermo({ description: '<p>Retiro de carnaval</p>' }),
    ).toBe(false);
    expect(exigeAceiteDeTermo(null)).toBe(false);
  });

  it('trata a caixa esvaziada no editor como evento sem termo', () => {
    // o que o editor devolve depois de digitar e apagar tudo — sem isto, todo
    // evento que passou pela etapa de termos passaria a pedir aceite
    expect(exigeAceiteDeTermo({ registrationTerm: '<p><br></p>' })).toBe(false);
    expect(exigeAceiteDeTermo({ registrationTerm: '<p>&nbsp;</p>' })).toBe(
      false,
    );
    expect(exigeAceiteDeTermo({ registrationTerm: '' })).toBe(false);
  });

  it('aceita termo escrito como imagem, sem texto nenhum', () => {
    expect(
      exigeAceiteDeTermo({
        registrationTerm: '<p><img src="data:image/png;base64,iVBOR"></p>',
      }),
    ).toBe(true);
  });
});

describe('termoDeInscricao', () => {
  it('devolve vazio quando o campo não é texto', () => {
    expect(termoDeInscricao({ registrationTerm: 42 })).toBe('');
    expect(termoDeInscricao(['nada disso'])).toBe('');
    expect(termoDeInscricao(undefined)).toBe('');
  });
});

describe('idadeDoTermo', () => {
  it('é 16 no evento anterior ao switch, que não tem a chave', () => {
    expect(idadeDoTermo({ registrationTerm: '<p>x</p>' })).toBe(16);
    expect(idadeDoTermo(null)).toBe(16);
  });

  it('é 18 só quando o evento pediu 18', () => {
    expect(idadeDoTermo({ minorAgeLimit: 18 })).toBe(18);
    expect(idadeDoTermo({ minorAgeLimit: 16 })).toBe(16);
  });

  it('ignora qualquer outro valor que venha no corpo', () => {
    expect(idadeDoTermo({ minorAgeLimit: '18' })).toBe(16);
    expect(idadeDoTermo({ minorAgeLimit: 21 })).toBe(16);
    expect(idadeDoTermo({ minorAgeLimit: 0 })).toBe(16);
  });
});
