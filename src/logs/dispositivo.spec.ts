import { descreverDispositivo } from './dispositivo';

/** User-Agents reais, a maioria tirada do próprio registro de login */
const CASOS: [string, Partial<ReturnType<typeof descreverDispositivo>>][] = [
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1',
    {
      tipo: 'celular',
      resumo: 'iPhone · iOS 18.7',
      aparelho: 'iPhone',
      sistema: 'iOS',
      versaoDoSistema: '18.7',
      navegador: 'Safari',
      versaoDoNavegador: '26.6',
      motor: 'WebKit',
      arquitetura: null,
    },
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    {
      tipo: 'computador',
      resumo: 'Windows',
      sistema: 'Windows',
      versaoDoSistema: '10 ou 11',
      navegador: 'Chrome',
      versaoDoNavegador: '153',
      motor: 'Blink',
      arquitetura: '64 bits (x64)',
    },
  ],
  [
    // Chrome no Mac: a versão do sistema é a congelada, não a instalada
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    {
      resumo: 'macOS',
      sistema: 'macOS',
      versaoDoSistema: null,
      navegador: 'Chrome',
      motor: 'Blink',
    },
  ],
  [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    {
      tipo: 'computador',
      resumo: 'Linux',
      arquitetura: '64 bits (x64)',
      versaoDoNavegador: '149',
    },
  ],
  [
    // Chrome no Android esconde o modelo e a versão atrás de "10; K"
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    {
      tipo: 'celular',
      resumo: 'Android',
      aparelho: null,
      versaoDoSistema: null,
      navegador: 'Chrome',
    },
  ],
  [
    // o navegador da Samsung ainda manda o modelo
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    {
      resumo: 'Android 14 · SM-S918B',
      aparelho: 'SM-S918B',
      versaoDoSistema: '14',
      navegador: 'Samsung Internet',
      versaoDoNavegador: '25.0',
    },
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0',
    {
      resumo: 'iPhone · iOS 17.5',
      navegador: 'Instagram',
      versaoDoNavegador: '330.0.0.0',
      motor: 'WebKit',
    },
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    { navegador: 'Edge', versaoDoNavegador: '140', motor: 'Blink' },
  ],
  [
    // o Firefox manda a versão real do macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0',
    {
      resumo: 'macOS 14.5',
      versaoDoSistema: '14.5',
      navegador: 'Firefox',
      motor: 'Gecko',
    },
  ],
];

describe('descreverDispositivo', () => {
  it.each(CASOS)('%s', (ua, esperado) => {
    expect(descreverDispositivo(ua)).toMatchObject(esperado);
  });

  it('sem User-Agent não inventa nada', () => {
    expect(descreverDispositivo(null)).toMatchObject({
      tipo: 'desconhecido',
      resumo: null,
      navegador: null,
    });
  });
});
