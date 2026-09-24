/**
 * O aparelho de um login, lido do `User-Agent` que o navegador mandou.
 *
 * É o que dá para saber sem pedir nada à pessoa, com os limites que os
 * navegadores impõem de propósito: o Chrome e o Safari congelam o macOS em
 * "10_15_7", o Windows sai "NT 10.0" tanto no 10 quanto no 11, o Chrome no
 * Android troca o modelo por "K" e a versão por "10", e o iPhone nunca diz
 * qual modelo é. O que o texto não afirma volta `null` — nada é adivinhado.
 */

export type TipoDeDispositivo =
  | 'celular'
  | 'tablet'
  | 'computador'
  | 'desconhecido';

export interface Dispositivo {
  tipo: TipoDeDispositivo;
  /** a linha da tabela: "iPhone · iOS 18.7", "Android 14 · SM-S918B", "macOS" */
  resumo: string | null;
  /** "iPhone", "iPad", o modelo do Android quando vem; computador não tem */
  aparelho: string | null;
  /** "iOS", "iPadOS", "Android", "Windows", "macOS", "Linux", "ChromeOS" */
  sistema: string | null;
  /** `null` quando o navegador esconde a versão real */
  versaoDoSistema: string | null;
  /** "Safari", "Chrome", "Instagram"… */
  navegador: string | null;
  versaoDoNavegador: string | null;
  /** quem desenha a página: "Blink" (Chrome e derivados), "WebKit", "Gecko" */
  motor: string | null;
  /** só quando o texto diz: "64 bits (x64)", "ARM" */
  arquitetura: string | null;
}

type Sistema = Pick<
  Dispositivo,
  'tipo' | 'aparelho' | 'sistema' | 'versaoDoSistema'
>;

const versao = (texto: string, regex: RegExp) =>
  texto.match(regex)?.[1]?.replace(/_/g, '.') ?? null;

function sistemaDe(ua: string): Sistema {
  if (/iPhone/.test(ua)) {
    return {
      tipo: 'celular',
      aparelho: 'iPhone',
      sistema: 'iOS',
      versaoDoSistema: versao(ua, /OS (\d+[_.]\d+(?:[_.]\d+)?)/),
    };
  }

  // iPad no modo desktop (padrão desde o iPadOS 13) se apresenta como Mac e
  // não tem como ser separado aqui
  if (/iPad/.test(ua)) {
    return {
      tipo: 'tablet',
      aparelho: 'iPad',
      sistema: 'iPadOS',
      versaoDoSistema: versao(ua, /OS (\d+[_.]\d+(?:[_.]\d+)?)/),
    };
  }

  if (/Android/.test(ua)) {
    const modelo =
      ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)?.[1]?.trim() ?? null;
    // "Android 10; K" é o disfarce do Chrome: nem a versão nem o modelo são
    // os de verdade
    const disfarcado = modelo === 'K';
    return {
      tipo: /Mobile/.test(ua) ? 'celular' : 'tablet',
      aparelho: disfarcado ? null : modelo,
      sistema: 'Android',
      versaoDoSistema: disfarcado
        ? null
        : versao(ua, /Android (\d+(?:\.\d+)*)/),
    };
  }

  if (/Windows NT/.test(ua)) {
    const nt = versao(ua, /Windows NT (\d+\.\d+)/);
    const nomes: Record<string, string> = {
      '10.0': '10 ou 11',
      '6.3': '8.1',
      '6.2': '8',
      '6.1': '7',
    };
    return {
      tipo: 'computador',
      aparelho: null,
      sistema: 'Windows',
      versaoDoSistema: nomes[nt ?? ''] ?? null,
    };
  }

  if (/CrOS/.test(ua)) {
    return {
      tipo: 'computador',
      aparelho: null,
      sistema: 'ChromeOS',
      versaoDoSistema: null,
    };
  }

  if (/Mac OS X|Macintosh/.test(ua)) {
    const mac = versao(ua, /Mac OS X (\d+[_.]\d+(?:[_.]\d+)?)/);
    return {
      tipo: 'computador',
      aparelho: null,
      sistema: 'macOS',
      // 10.15.7 é o valor congelado, não a versão instalada
      versaoDoSistema: mac === '10.15.7' ? null : mac,
    };
  }

  if (/Linux/.test(ua)) {
    return {
      tipo: 'computador',
      aparelho: null,
      sistema: 'Linux',
      versaoDoSistema: null,
    };
  }

  return {
    tipo: 'desconhecido',
    aparelho: null,
    sistema: null,
    versaoDoSistema: null,
  };
}

/**
 * A ordem importa: quase todo navegador se diz "Chrome" e "Safari" no meio do
 * texto, então os específicos vêm antes. Os apps (Instagram, WhatsApp…) abrem
 * o link no próprio navegador embutido e se identificam no fim do texto.
 */
const NAVEGADORES: [string, RegExp][] = [
  ['Instagram', /Instagram(?: ([\d.]+))?/],
  ['Facebook', /FB(?:AN|AV)\/?([\d.]+)?/],
  ['WhatsApp', /WhatsApp\/?([\d.]+)?/],
  ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
  ['Opera', /OPR\/(\d+)/],
  ['Samsung Internet', /SamsungBrowser\/(\d+(?:\.\d+)?)/],
  ['Chrome', /CriOS\/(\d+)/],
  ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
  ['Chrome', /Chrome\/(\d+)/],
  ['Safari', /Version\/(\d+(?:\.\d+)?).*Safari/],
];

function navegadorDe(
  ua: string,
): Pick<Dispositivo, 'navegador' | 'versaoDoNavegador'> {
  for (const [nome, regex] of NAVEGADORES) {
    const achou = ua.match(regex);
    if (achou) return { navegador: nome, versaoDoNavegador: achou[1] ?? null };
  }
  return { navegador: null, versaoDoNavegador: null };
}

function motorDe(ua: string, sistema: string | null): string | null {
  // no iPhone e no iPad todo navegador é Safari por baixo: a Apple exige
  if (sistema === 'iOS' || sistema === 'iPadOS') return 'WebKit';
  if (/Gecko\/\d/.test(ua) && /Firefox/.test(ua)) return 'Gecko';
  if (/Chrome\//.test(ua)) return 'Blink';
  if (/AppleWebKit/.test(ua)) return 'WebKit';
  return null;
}

function arquiteturaDe(ua: string): string | null {
  if (/Win64; x64|x86_64|WOW64|amd64/i.test(ua)) return '64 bits (x64)';
  if (/aarch64|arm64/i.test(ua)) return 'ARM (64 bits)';
  if (/armv7|armv8l/i.test(ua)) return 'ARM';
  return null;
}

function resumoDe({ aparelho, sistema, versaoDoSistema }: Sistema) {
  const sistemaComVersao =
    sistema && versaoDoSistema && sistema !== 'Windows'
      ? `${sistema} ${versaoDoSistema}`
      : sistema;
  // iPhone e iPad dizem o aparelho antes; o modelo do Android vem depois
  const partes =
    aparelho === 'iPhone' || aparelho === 'iPad'
      ? [aparelho, sistemaComVersao]
      : [sistemaComVersao, aparelho];
  return partes.filter(Boolean).join(' · ') || null;
}

export function descreverDispositivo(userAgent?: string | null): Dispositivo {
  const ua = (userAgent ?? '').trim();
  const vazio: Dispositivo = {
    tipo: 'desconhecido',
    resumo: null,
    aparelho: null,
    sistema: null,
    versaoDoSistema: null,
    navegador: null,
    versaoDoNavegador: null,
    motor: null,
    arquitetura: null,
  };
  if (!ua) return vazio;

  const sistema = sistemaDe(ua);
  return {
    ...sistema,
    resumo: resumoDe(sistema),
    ...navegadorDe(ua),
    motor: motorDe(ua, sistema.sistema),
    arquitetura: arquiteturaDe(ua),
  };
}
