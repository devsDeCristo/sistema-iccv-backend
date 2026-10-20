import {
  eventoTerminou,
  novoCodigo,
  periodoPorExtenso,
} from './certificado-regras';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('periodoPorExtenso', () => {
  it('um dia só', () => {
    expect(periodoPorExtenso(utc('2027-02-05'), utc('2027-02-05'))).toBe(
      'em 5 de fevereiro de 2027',
    );
  });

  it('dias no mesmo mês', () => {
    expect(periodoPorExtenso(utc('2027-02-04'), utc('2027-02-07'))).toBe(
      'de 4 a 7 de fevereiro de 2027',
    );
  });

  it('virando o mês', () => {
    expect(periodoPorExtenso(utc('2027-01-30'), utc('2027-02-02'))).toBe(
      'de 30 de janeiro a 2 de fevereiro de 2027',
    );
  });

  it('virando o ano', () => {
    expect(periodoPorExtenso(utc('2026-12-30'), utc('2027-01-02'))).toBe(
      'de 30 de dezembro de 2026 a 2 de janeiro de 2027',
    );
  });
});

describe('eventoTerminou', () => {
  const fim = utc('2027-02-07');

  it('no último dia o evento ainda não terminou', () => {
    expect(eventoTerminou(fim, new Date('2027-02-07T20:00:00Z'))).toBe(false);
  });

  it('depois do último dia inteiro, terminou', () => {
    expect(eventoTerminou(fim, new Date('2027-02-08T00:00:00Z'))).toBe(true);
  });
});

describe('novoCodigo', () => {
  it('sai como XXXX-XXXX, sem letras que se confundem', () => {
    for (let i = 0; i < 200; i++) {
      expect(novoCodigo()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    }
  });
});
