import { JANELA_MS, situacaoDoLogin } from './protecao-de-login';

const MIN = 60 * 1000;
const agora = new Date('2026-09-28T12:00:00Z');
/** falhas a `minutos` atrás, da mais nova para a mais antiga */
const falhas = (...minutos: number[]) =>
  minutos.map((m) => new Date(agora.getTime() - m * MIN));

describe('situacaoDoLogin', () => {
  it('sem falhas, entra direto', () => {
    expect(situacaoDoLogin([], agora)).toEqual({
      bloqueadoAte: null,
      exigeCaptcha: false,
    });
  });

  it('uma falha ainda não pede captcha; duas pedem', () => {
    expect(situacaoDoLogin(falhas(1), agora).exigeCaptcha).toBe(false);
    expect(situacaoDoLogin(falhas(1, 2), agora).exigeCaptcha).toBe(true);
  });

  it('cinco falhas na janela bloqueiam até 15 min depois da última', () => {
    const s = situacaoDoLogin(falhas(2, 3, 4, 5, 6), agora);
    expect(s.bloqueadoAte).toEqual(new Date(agora.getTime() - 2 * MIN + JANELA_MS));
  });

  it('falha antiga saindo da janela não solta o bloqueio antes da hora', () => {
    // a 5ª falha foi há 10 min, a 1ª há 24: contadas a partir da última, as
    // cinco cabem na janela, e o bloqueio vai até 5 min daqui
    const s = situacaoDoLogin(falhas(10, 11, 12, 20, 24), agora);
    expect(s.bloqueadoAte).toEqual(new Date(agora.getTime() + 5 * MIN));
  });

  it('passado o bloqueio, volta ao normal', () => {
    expect(situacaoDoLogin(falhas(16, 17, 18, 19, 20), agora)).toEqual({
      bloqueadoAte: null,
      exigeCaptcha: false,
    });
  });

  it('cinco falhas espalhadas além da janela não bloqueiam', () => {
    expect(situacaoDoLogin(falhas(1, 5, 20, 25, 29), agora).bloqueadoAte).toBeNull();
  });
});
