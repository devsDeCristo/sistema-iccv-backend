/**
 * Layout do PDF do quadrante.
 *
 * Sai em dois documentos que o serviço junta depois: a capa, sem margem nem
 * cabeçalho, e as páginas das equipes, com cabeçalho e rodapé em todas. O Chrome
 * desenha o cabeçalho do Puppeteer em toda página, inclusive por cima de uma
 * capa sem margem — gerar separado é o único jeito de a capa sair limpa.
 *
 * Tudo aqui é HTML em texto: o que vem do banco passa por `escapeHtml`.
 */

export interface PessoaDoPdf {
  id: string;
  fullName: string;
  /** já embutida como data URI, ou `null` (sem foto, ou falhou o download) */
  profilePhotoUrl: string | null;
  cellphone: string;
  birthday: Date;
  email: string;
  roleTeam: 'LEADER' | 'MEMBER';
}

export interface EquipeDoPdf {
  id: string;
  name: string;
  users: PessoaDoPdf[];
}

export interface EventoDoPdf {
  name: string;
  periodo: string;
  /** data URIs já reduzidos, ou ausentes */
  logo?: string;
  capa?: string;
  colors: { primary?: string; secondary?: string; tertiary?: string } | null;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  );
}

// ---------------------------------------------------------------- formatação

/** Só dia e mês, como na tela: é o aniversário, não a idade. As datas são
 * gravadas à meia-noite UTC, então o fuso precisa ser fixado. */
function formatarAniversario(valor: Date): string {
  return new Date(valor).toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

function formatarCelular(valor = ''): string {
  const d = valor.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return valor;
}

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/);
  return (
    (partes[0]?.[0] ?? '') +
    (partes.length > 1 ? partes[partes.length - 1][0] : '')
  ).toUpperCase();
}

// ---------------------------------------------------------------------- cores

const AZUL_VIVO = '#2563EB';
const VIOLETA_VIVO = '#7C3AED';

function ehHex(valor?: string): valor is string {
  return !!valor && /^#[0-9a-fA-F]{6}$/.test(valor);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: number[]): string {
  return `#${[r, g, b]
    .map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Mistura `cor` com `outra`; `peso` é quanto de `outra` entra (0 a 1). */
function misturar(cor: string, outra: string, peso: number): string {
  const a = rgb(cor);
  const b = rgb(outra);
  return hex(a.map((c, i) => c + (b[i] - c) * peso));
}

function luminancia(cor: string): number {
  const [r, g, b] = rgb(cor).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A cor escurecida até dar para ler sobre branco (4,5:1). A paleta sai da logo
 * e da capa, e um amarelo cru some no papel.
 */
function legivelNoBranco(cor: string): string {
  let tom = cor;
  for (let passo = 1; passo <= 9 && 1.05 / (luminancia(tom) + 0.05) < 4.5; passo++) {
    tom = misturar(cor, '#000000', passo * 0.1);
  }
  return tom;
}

interface CorDaEquipe {
  /** texto e detalhes finos: já legível sobre branco */
  forte: string;
  /** fundo de etiqueta e de foto vazia */
  suave: string;
  /** borda do cartão de líder e faixa lateral */
  media: string;
}

function paletaDoEvento(colors: EventoDoPdf['colors']) {
  const primaria = ehHex(colors?.primary) ? colors!.primary! : AZUL_VIVO;
  const secundaria = ehHex(colors?.secondary)
    ? colors!.secondary!
    : ehHex(colors?.primary)
      ? primaria
      : VIOLETA_VIVO;
  const terciaria = ehHex(colors?.tertiary) ? colors!.tertiary! : primaria;

  // suave e média saem do tom já legível, e não da cor crua: uma cor clara da
  // paleta clareada mais ainda vira branco, e a etiqueta some no papel
  const porEquipe: CorDaEquipe[] = [primaria, secundaria, terciaria].map((cor) => {
    const forte = legivelNoBranco(cor);
    return {
      forte,
      suave: misturar(forte, '#ffffff', 0.86),
      media: misturar(forte, '#ffffff', 0.45),
    };
  });

  return {
    primaria,
    primariaForte: legivelNoBranco(primaria),
    secundaria,
    daEquipe: (indice: number) => porEquipe[indice % porEquipe.length],
  };
}

// --------------------------------------------------------------------- ícones

const ICONES = {
  celular:
    'M15.5 1h-8C6.12 1 5 2.12 5 3.5v17C5 21.88 6.12 23 7.5 23h8c1.38 0 2.5-1.12 2.5-2.5v-17C18 2.12 16.88 1 15.5 1m-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5m4.5-4H7V4h9z',
  email:
    'M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2zm-2 0-8 5-8-5zm0 12H4V8l8 5 8-5z',
  bolo: 'M12 6c1.11 0 2-.9 2-2 0-.38-.1-.73-.29-1.03L12 0l-1.71 2.97c-.19.3-.29.65-.29 1.03 0 1.1.9 2 2 2m6 3h-5V7h-2v2H6c-1.66 0-3 1.34-3 3v9c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-9c0-1.66-1.34-3-3-3m1 11H5v-3c.9-.01 1.76-.37 2.4-1.01l1.09-1.07 1.07 1.07c1.31 1.31 3.59 1.3 4.89 0l1.08-1.07 1.07 1.07c.64.64 1.5 1 2.4 1.01zm0-4.5c-.51-.01-.99-.2-1.35-.57l-2.13-2.13-2.14 2.13c-.74.74-2.03.74-2.77 0L8.48 12.8l-2.14 2.13c-.35.36-.83.56-1.34.57V12c0-.55.45-1 1-1h12c.55 0 1 .45 1 1z',
  estrela:
    'm12 17.27 4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.72 3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18-1.1 4.72c-.2.86.73 1.54 1.49 1.08z',
};

function icone(nome: keyof typeof ICONES): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONES[nome]}" fill="currentColor"/></svg>`;
}

// ----------------------------------------------------------------------- base

/** Arredondada como a tela; se o Google Fonts não responder, cai na Helvetica. */
const FONTE = `'Nunito', 'Helvetica Neue', Helvetica, Arial, sans-serif`;
const LINK_DA_FONTE =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=block" />';

function documento(estilo: string, corpo: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    ${LINK_DA_FONTE}
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; }
      body {
        font-family: ${FONTE};
        color: #1d1d27;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      ${estilo}
    </style>
  </head>
  <body>${corpo}</body>
</html>`;
}

// ----------------------------------------------------------------------- capa

export function htmlDaCapa(
  evento: EventoDoPdf,
  totais: { equipes: number; pessoas: number },
): string {
  const paleta = paletaDoEvento(evento.colors);
  const fundoSemImagem = `linear-gradient(135deg, ${misturar(
    paleta.primaria,
    '#000000',
    0.45,
  )}, ${misturar(paleta.secundaria, '#000000', 0.25)})`;

  const estilo = `
    @page { size: A4 landscape; margin: 0; }
    .capa {
      position: relative;
      width: 297mm;
      height: 210mm;
      overflow: hidden;
      color: #fff;
      background: ${fundoSemImagem};
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      padding: 22mm 24mm;
    }
    .capa-fundo {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: cover;
    }
    /* mesmo tratamento da página do evento: foto assentada por um véu escuro,
       mais fechado embaixo, onde fica o texto */
    .capa-veu {
      position: absolute; inset: 0;
      background:
        linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.35) 45%, rgba(0,0,0,.78) 100%);
    }
    .capa-conteudo { position: relative; }
    .capa-logo {
      display: block;
      max-width: 90mm;
      max-height: 45mm;
      object-fit: contain;
      margin-bottom: 8mm;
      filter: drop-shadow(0 4px 14px rgba(0,0,0,.5));
    }
    .capa-selo {
      display: inline-block;
      padding: 1.2mm 3.5mm;
      border-radius: 99px;
      border: 1px solid rgba(255,255,255,.4);
      background: rgba(255,255,255,.16);
      font-size: 9pt;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
      margin-bottom: 4mm;
    }
    .capa-nome {
      margin: 0;
      font-size: 34pt;
      font-weight: 800;
      line-height: 1.05;
      letter-spacing: -.01em;
      max-width: 220mm;
      text-shadow: 0 2px 18px rgba(0,0,0,.45);
    }
    .capa-rodape {
      display: flex;
      gap: 3mm;
      margin-top: 7mm;
      font-size: 11pt;
      font-weight: 600;
    }
    .capa-rodape span {
      padding: 1.5mm 4mm;
      border-radius: 99px;
      background: rgba(0,0,0,.28);
      border: 1px solid rgba(255,255,255,.22);
    }
    .capa-faixa {
      position: absolute; left: 0; right: 0; bottom: 0; height: 3mm;
      background: linear-gradient(90deg, ${paleta.primaria}, ${paleta.secundaria});
    }`;

  const corpo = `
    <section class="capa">
      ${evento.capa ? `<img class="capa-fundo" src="${evento.capa}" alt="" />` : ''}
      ${evento.capa ? '<div class="capa-veu"></div>' : ''}
      <div class="capa-conteudo">
        ${evento.logo ? `<img class="capa-logo" src="${evento.logo}" alt="" />` : ''}
        <div class="capa-selo">Quadrante</div>
        <h1 class="capa-nome">${escapeHtml(evento.name)}</h1>
        <div class="capa-rodape">
          <span>${escapeHtml(evento.periodo)}</span>
          <span>${totais.equipes} ${totais.equipes === 1 ? 'equipe' : 'equipes'}</span>
          <span>${totais.pessoas} ${totais.pessoas === 1 ? 'pessoa' : 'pessoas'}</span>
        </div>
      </div>
      <div class="capa-faixa"></div>
    </section>`;

  return documento(estilo, corpo);
}

// -------------------------------------------------------------------- equipes

function htmlDoCartao(pessoa: PessoaDoPdf): string {
  const lider = pessoa.roleTeam === 'LEADER';
  const foto = pessoa.profilePhotoUrl
    ? `<img src="${pessoa.profilePhotoUrl}" alt="" />`
    : `<span>${escapeHtml(iniciais(pessoa.fullName))}</span>`;

  return `
    <article class="cartao${lider ? ' lider' : ''}">
      <div class="foto">${foto}</div>
      <div class="dados">
        <div class="nome">${escapeHtml(pessoa.fullName)}</div>
        ${lider ? `<div class="selo-lider">${icone('estrela')}Líder</div>` : ''}
        <div class="linhas">
          <div class="linha">${icone('celular')}<span>${escapeHtml(
            formatarCelular(pessoa.cellphone),
          )}</span></div>
          <div class="linha">${icone('email')}<span>${escapeHtml(pessoa.email)}</span></div>
          <div class="linha">${icone('bolo')}<span>${escapeHtml(
            formatarAniversario(pessoa.birthday),
          )}</span></div>
        </div>
      </div>
    </article>`;
}

export function htmlDasEquipes(evento: EventoDoPdf, equipes: EquipeDoPdf[]): string {
  const paleta = paletaDoEvento(evento.colors);

  /**
   * Cada equipe leva uma das três cores do evento, em rodízio — a mesma ordem
   * da tela. As cores entram como variáveis na seção, e o CSS dos cartões é
   * um só.
   */
  const secoes = equipes
    .map((equipe, indice) => {
      const cor = paleta.daEquipe(indice);
      const total = equipe.users.length;

      return `
        <section class="equipe" style="--forte:${cor.forte};--suave:${cor.suave};--media:${cor.media}">
          <header class="equipe-titulo">
            <span class="risco"></span>
            <h2>${escapeHtml(equipe.name)}</h2>
            <span class="contador">${total} ${total === 1 ? 'pessoa' : 'pessoas'}</span>
          </header>
          <div class="grade">${equipe.users.map(htmlDoCartao).join('')}</div>
        </section>`;
    })
    .join('');

  const estilo = `
    /* as margens abrem espaço para o cabeçalho e o rodapé do Puppeteer */
    @page { size: A4 landscape; margin: 19mm 10mm 14mm; }

    .equipe { margin-bottom: 7mm; }
    .equipe-titulo {
      display: flex;
      align-items: center;
      gap: 2.5mm;
      margin: 0 0 3mm;
      /* título no pé da página com os cartões só na seguinte é o que mais
         atrapalha na hora de usar */
      break-after: avoid;
    }
    .risco { width: 1.4mm; height: 6mm; border-radius: 1mm; background: var(--forte); }
    .equipe-titulo h2 { margin: 0; font-size: 14pt; font-weight: 800; color: #1d1d27; }
    .contador {
      padding: .6mm 2.5mm;
      border-radius: 99px;
      font-size: 7.5pt;
      font-weight: 700;
      color: var(--forte);
      background: var(--suave);
    }

    .grade {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2.5mm;
    }
    .cartao {
      position: relative;
      display: flex;
      gap: 2.5mm;
      padding: 2.2mm 2.5mm 2.2mm 3.4mm;
      border: .25mm solid #e3e3ea;
      border-radius: 2.2mm;
      background: #fff;
      overflow: hidden;
      break-inside: avoid;
    }
    /* faixa lateral na cor da equipe: é o que amarra o cartão à equipe mesmo
       quando a página vira e o título ficou para trás */
    .cartao::before {
      content: '';
      position: absolute; left: 0; top: 0; bottom: 0;
      width: 1.1mm;
      background: var(--media);
    }
    .cartao.lider { border-color: var(--media); background: var(--suave); }
    .cartao.lider::before { background: var(--forte); }

    .foto {
      width: 15mm;
      height: 19mm;
      flex-shrink: 0;
      border-radius: 1.6mm;
      overflow: hidden;
      display: grid;
      place-items: center;
      background: var(--suave);
      color: var(--forte);
      font-size: 11pt;
      font-weight: 800;
    }
    .cartao.lider .foto { background: #fff; }
    .foto img { width: 100%; height: 100%; object-fit: cover; display: block; }

    .dados { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; }
    .nome {
      font-size: 8.5pt;
      font-weight: 800;
      line-height: 1.2;
      color: #1d1d27;
      /* nome comprido quebra em duas linhas, não mais */
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .selo-lider {
      display: inline-flex;
      align-self: flex-start;
      align-items: center;
      gap: .6mm;
      margin-top: .7mm;
      padding: .2mm 1.6mm .2mm 1mm;
      border-radius: 99px;
      font-size: 6pt;
      font-weight: 800;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: #fff;
      background: var(--forte);
    }
    .selo-lider svg { width: 2.6mm; height: 2.6mm; }

    .linhas { margin-top: 1.3mm; display: flex; flex-direction: column; gap: .7mm; }
    .linha {
      display: flex;
      align-items: center;
      gap: 1.2mm;
      min-width: 0;
      font-size: 6.8pt;
      color: #4a4a57;
    }
    .linha svg { width: 2.8mm; height: 2.8mm; flex-shrink: 0; color: var(--forte); opacity: .85; }
    .linha span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`;

  return documento(estilo, secoes);
}

// --------------------------------------------------------- cabeçalho e rodapé

/**
 * Os templates do Puppeteer não herdam nada da página: fonte, tamanho e cor vão
 * inline, e imagem só como data URI. Fonte web também não carrega ali, por isso
 * a pilha começa pela Helvetica.
 */
const BASE_DO_TEMPLATE =
  'font-family: Helvetica, Arial, sans-serif; width: 100%; margin: 0 10mm; -webkit-print-color-adjust: exact; print-color-adjust: exact;';

export function cabecalho(evento: EventoDoPdf): string {
  const paleta = paletaDoEvento(evento.colors);
  const logo = evento.logo
    ? `<img src="${evento.logo}" style="height: 7mm; max-width: 28mm; object-fit: contain; margin-right: 3mm;" />`
    : '';

  return `
    <div style="${BASE_DO_TEMPLATE} display: flex; align-items: center; padding-bottom: 2mm; border-bottom: .5mm solid ${paleta.primaria};">
      ${logo}
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 9pt; font-weight: bold; color: #1d1d27; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(evento.name)}</div>
        <div style="font-size: 7pt; color: #6b6b78;">${escapeHtml(evento.periodo)}</div>
      </div>
      <div style="font-size: 7pt; font-weight: bold; letter-spacing: .14em; text-transform: uppercase; color: ${paleta.primariaForte};">Quadrante</div>
    </div>`;
}

export function rodape(evento: EventoDoPdf): string {
  return `
    <div style="${BASE_DO_TEMPLATE} display: flex; justify-content: space-between; align-items: center; font-size: 7pt; color: #8a8a96;">
      <span>${escapeHtml(evento.name)} · Quadrante</span>
      <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
    </div>`;
}
