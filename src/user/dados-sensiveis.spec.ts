import { aplicarConsentimento, separarSensiveis } from './dados-sensiveis';

const AGORA = new Date('2026-09-25T12:00:00Z');
const ANTES = new Date('2026-01-10T12:00:00Z');
const SAUDE = { religion: 'Evangélica', diabetes: true, hypertensive: false };

describe('dados sensíveis', () => {
  it('sem consentimento, nada sensível é gravado', () => {
    expect(aplicarConsentimento(SAUDE, undefined, null, AGORA)).toEqual({});
  });

  it('consentindo agora, grava e registra a data', () => {
    expect(aplicarConsentimento(SAUDE, true, null, AGORA)).toEqual({
      ...SAUDE,
      sensitiveConsentAt: AGORA,
    });
  });

  it('quem já consentiu mantém a data original', () => {
    expect(
      aplicarConsentimento(SAUDE, true, ANTES, AGORA).sensitiveConsentAt,
    ).toBe(ANTES);
  });

  it('com consentimento anterior, a edição grava o que veio', () => {
    expect(aplicarConsentimento({ diabetes: false }, undefined, ANTES)).toEqual(
      {
        diabetes: false,
      },
    );
  });

  it('revogar apaga os três campos e o consentimento', () => {
    expect(aplicarConsentimento(SAUDE, false, ANTES)).toEqual({
      religion: null,
      diabetes: null,
      hypertensive: null,
      sensitiveConsentAt: null,
    });
  });

  it('religião em branco é não informada', () => {
    expect(
      aplicarConsentimento({ religion: '' }, true, null, AGORA).religion,
    ).toBeNull();
  });

  it('separa os sensíveis do resto do corpo', () => {
    const [sensiveis, resto] = separarSensiveis({ fullName: 'Ana', ...SAUDE });
    expect(sensiveis).toEqual(SAUDE);
    expect(resto).toEqual({ fullName: 'Ana' });
  });
});
