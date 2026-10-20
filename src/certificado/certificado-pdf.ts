/**
 * Layout do certificado de participação.
 *
 * Tudo aqui é HTML em texto, impresso pelo Chrome do servidor como o quadrante
 * e os crachás: o que vem do banco passa por `escapeHtml`. Imagens (logo do
 * evento, assinaturas) chegam já como data URI — o Chrome não busca nada fora.
 */

import * as QRCode from 'qrcode';
import { linkDaFonte } from '../pdf/fonte';
import {
  EventoDoPdf,
  escapeHtml,
  misturar,
  paletaDoEvento,
} from '../quadrante/quadrante-pdf';

/**
 * Times New Roman, a letra de diploma. O Chrome do servidor (Linux) não tem
 * ela: lá entra a Tinos, desenhada com as mesmas medidas, embutida do Google.
 */
const FONTE = `'Times New Roman', 'Tinos', Times, serif`;
export const URL_DA_FONTE_DO_CERTIFICADO =
  'https://fonts.googleapis.com/css2?family=Tinos:ital,wght@0,400;0,700;1,400;1,700&display=block';

export interface AssinaturaDoCertificado {
  name: string;
  role: string;
  /** data URI da imagem, ou nula (fica só a linha) */
  signature: string | null;
}

export interface CertificadoDoPdf {
  nome: string;
  codigo: string;
  /** endereço público que confirma o certificado */
  urlDeVerificacao: string;
}

export interface EventoDoCertificado {
  nome: string;
  igreja: string;
  /** "de 4 a 7 de fevereiro de 2027" */
  periodo: string;
  cargaHoraria: string | null;
  logo?: string;
  colors: EventoDoPdf['colors'];
  assinaturas: AssinaturaDoCertificado[];
  /** "20 de outubro de 2026" */
  emitidoEm: string;
}

function documento(estilo: string, corpo: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    ${linkDaFonte(URL_DA_FONTE_DO_CERTIFICADO)}
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

/** O QR como SVG em linha: nítido em qualquer zoom e sem imagem a embutir */
export function qrEmSvg(texto: string): string {
  const { modules } = QRCode.create(texto, { errorCorrectionLevel: 'M' });
  const margem = 1;
  const lado = modules.size + margem * 2;
  let d = '';
  for (let linha = 0; linha < modules.size; linha++) {
    for (let coluna = 0; coluna < modules.size; coluna++) {
      if (modules.get(linha, coluna)) {
        d += `M${coluna + margem},${linha + margem}h1v1h-1z`;
      }
    }
  }
  return `<svg viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges"><path d="${d}" fill="#1d1d27"/></svg>`;
}

// ----------------------------------------------------------------- certificado

/** A folha, em mm: A4 deitada */
const LARGURA = 297;
const ALTURA = 210;
/** Onde corre a faixa ondulada, a partir da borda da folha */
const FAIXA = 12.5;
/** Quanto do canto fica para o ornamento, sem onda por baixo */
const CANTO = 27;
/** O marfim da folha */
const PAPEL = '#fffdf8';

/**
 * Uma onda que corre por um lado da moldura, de `de` até `ate`, oscilando para
 * dentro e para fora da linha da faixa. Quatro delas, defasadas, se cruzam e
 * fazem o entrelaçado de diploma (guilhochê).
 */
function onda(
  de: [number, number],
  ate: [number, number],
  fase: number,
  amplitude = 1.7,
  comprimento = 6,
): string {
  const [dx, dy] = [ate[0] - de[0], ate[1] - de[1]];
  const tamanho = Math.hypot(dx, dy);
  const [nx, ny] = [-dy / tamanho, dx / tamanho];
  const pontos: string[] = [];
  for (let t = 0; t <= tamanho; t += 0.4) {
    const desvio = amplitude * Math.sin((2 * Math.PI * t) / comprimento + fase);
    pontos.push(
      `${(de[0] + (dx * t) / tamanho + nx * desvio).toFixed(2)},${(
        de[1] +
        (dy * t) / tamanho +
        ny * desvio
      ).toFixed(2)}`,
    );
  }
  return `M${pontos.join('L')}`;
}

/**
 * O ornamento de um canto, desenhado no de cima à esquerda: o losango no
 * cruzamento das faixas, as volutas que saem dele ao longo dos dois lados e a
 * folha que aponta para dentro da folha. Por baixo, um quadrado da cor do
 * papel interrompe as linhas internas, que terminam no ornamento em vez de
 * cruzá-lo. Os outros três são ele espelhado.
 */
const ORNAMENTO_DO_CANTO = `
  <rect x="8.4" y="8.4" width="23" height="23" class="fundo" />
  <circle cx="${FAIXA}" cy="${FAIXA}" r="5.2" class="fino" />
  <path d="M${FAIXA},${FAIXA - 3.4} L${FAIXA + 3.4},${FAIXA} L${FAIXA},${
  FAIXA + 3.4
} L${FAIXA - 3.4},${FAIXA} Z" class="cheio" />
  <g class="voluta">
    <path d="M17.7,12.5 C21,8.2 25.5,8.2 26.5,11.6 C27.3,14.6 24,16 22.6,13.9 C21.6,12.4 23,11.2 24,12" />
    <path d="M12.5,17.7 C8.2,21 8.2,25.5 11.6,26.5 C14.6,27.3 16,24 13.9,22.6 C12.4,21.6 11.2,23 12,24" />
    <path d="M16.3,16.3 C19.5,17.5 21,20 20.4,22.6 C19.9,24.6 17.6,24.4 17.8,22.6" />
    <path d="M16.3,16.3 C17.5,19.5 20,21 22.6,20.4 C24.6,19.9 24.4,17.6 22.6,17.8" />
  </g>
  <path d="M18.5,18.5 Q25,21 29,29 Q21,25 18.5,18.5 Z" class="cheio" />
  <circle cx="30.4" cy="30.4" r="0.9" class="cheio" />
`;

/** A moldura inteira, uma vez por documento; cada folha a reusa (`<use>`) */
function moldura(forte: string, media: string): string {
  const [a, b] = [FAIXA, LARGURA - FAIXA];
  const [c, d] = [FAIXA, ALTURA - FAIXA];
  const lados: [[number, number], [number, number]][] = [
    [
      [a + CANTO - FAIXA, c],
      [b - CANTO + FAIXA, c],
    ],
    [
      [b, c + CANTO - FAIXA],
      [b, d - CANTO + FAIXA],
    ],
    [
      [b - CANTO + FAIXA, d],
      [a + CANTO - FAIXA, d],
    ],
    [
      [a, d - CANTO + FAIXA],
      [a, c + CANTO - FAIXA],
    ],
  ];
  const ondas = lados
    .flatMap(([de, ate]) =>
      [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((fase) =>
        onda(de, ate, fase),
      ),
    )
    .join(' ');

  const retangulo = (recuo: number, classe: string) =>
    `<rect x="${recuo}" y="${recuo}" width="${LARGURA - 2 * recuo}" height="${
      ALTURA - 2 * recuo
    }" class="${classe}" />`;

  const cantos = [
    '',
    `transform="translate(${LARGURA} 0) scale(-1 1)"`,
    `transform="translate(0 ${ALTURA}) scale(1 -1)"`,
    `transform="translate(${LARGURA} ${ALTURA}) scale(-1 -1)"`,
  ]
    .map((t) => `<g ${t}>${ORNAMENTO_DO_CANTO}</g>`)
    .join('');

  return `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
      <defs>
        <symbol id="moldura" viewBox="0 0 ${LARGURA} ${ALTURA}">
          <style>
            .grosso { fill: none; stroke: ${forte}; stroke-width: 1.1; }
            .fino { fill: none; stroke: ${forte}; stroke-width: 0.3; }
            .onda { fill: none; stroke: ${media}; stroke-width: 0.22; }
            .voluta path { fill: none; stroke: ${forte}; stroke-width: 0.45; stroke-linecap: round; }
            .cheio { fill: ${forte}; }
            .fundo { fill: ${PAPEL}; }
          </style>
          ${retangulo(6, 'grosso')}
          ${retangulo(8, 'fino')}
          <path d="${ondas}" class="onda" />
          ${retangulo(17, 'fino')}
          ${retangulo(18.2, 'fino')}
          ${cantos}
        </symbol>
      </defs>
    </svg>`;
}

/** O fio com losango no meio, que separa o título do resto */
const FIO = (cor: string) => `
  <svg class="fio" viewBox="0 0 120 6" aria-hidden="true">
    <path d="M2,3 H52 M68,3 H118" stroke="${cor}" stroke-width="0.5" />
    <path d="M60,0.4 L62.6,3 L60,5.6 L57.4,3 Z M54,3 L55.6,1.6 L57.2,3 L55.6,4.4 Z M66,3 L64.4,1.6 L62.8,3 L64.4,4.4 Z" fill="${cor}" />
  </svg>`;

/**
 * Uma página A4 deitada por pessoa, com cara de diploma: moldura em duas
 * linhas com o entrelaçado ondulado entre elas e ornamento nos cantos, tudo na
 * cor do evento, e letra Times. O nome é o centro da folha. Embaixo, as
 * assinaturas (com a imagem sobre a linha, quando houver) e, no canto, o QR
 * com o código — é ele que permite a quem recebe conferir que é verdadeiro.
 */
export function htmlDosCertificados(
  evento: EventoDoCertificado,
  certificados: CertificadoDoPdf[],
): string {
  const paleta = paletaDoEvento(evento.colors);
  const forte = paleta.primariaForte;
  const media = misturar(forte, '#ffffff', 0.45);

  const texto = [
    `participou do evento <strong>${escapeHtml(evento.nome)}</strong>`,
    `promovido por ${escapeHtml(evento.igreja)}`,
    `realizado ${escapeHtml(evento.periodo)}`,
  ].join(', ');
  const carga = evento.cargaHoraria
    ? `, com carga horária de <strong>${escapeHtml(
        evento.cargaHoraria,
      )}</strong>`
    : '';

  const assinaturas = evento.assinaturas
    .map(
      (a) => `
      <div class="assinatura">
        <div class="tracado">${
          a.signature ? `<img src="${escapeHtml(a.signature)}" alt="" />` : ''
        }</div>
        <div class="linha"></div>
        <div class="quem">${escapeHtml(a.name)}</div>
        <div class="cargo">${escapeHtml(a.role)}</div>
      </div>`,
    )
    .join('');

  const paginas = certificados
    .map(
      (c) => `
    <section class="folha">
      <svg class="enfeite"><use href="#moldura" /></svg>
      <div class="miolo">
        <header>
          ${
            evento.logo
              ? `<img class="logo" src="${evento.logo}" alt="" />`
              : ''
          }
          <div class="titulo">Certificado</div>
          <div class="subtitulo">de participação</div>
          ${FIO(forte)}
        </header>

        <main>
          <div class="certificamos">Certificamos que</div>
          <div class="nome">${escapeHtml(c.nome)}</div>
          <p class="texto">${texto}${carga}.</p>
        </main>

        <footer>
          <div class="assinaturas">${assinaturas}</div>
          <div class="autenticidade">
            <div class="qr">${qrEmSvg(c.urlDeVerificacao)}</div>
            <div class="codigo">
              <div>Emitido em ${escapeHtml(evento.emitidoEm)}</div>
              <div>Código <strong>${escapeHtml(c.codigo)}</strong></div>
              <div class="url">${escapeHtml(c.urlDeVerificacao)}</div>
            </div>
          </div>
        </footer>
      </div>
    </section>`,
    )
    .join('');

  return documento(
    `
      @page { size: A4 landscape; margin: 0; }
      .folha {
        position: relative; width: ${LARGURA}mm; height: ${ALTURA}mm;
        page-break-after: always; background: ${PAPEL}; overflow: hidden;
      }
      .folha:last-child { page-break-after: auto; }
      .enfeite { position: absolute; inset: 0; width: 100%; height: 100%; }
      .miolo {
        position: relative; height: 100%; padding: 24mm 32mm 22mm;
        display: flex; flex-direction: column;
      }
      header { text-align: center; }
      .logo { max-height: 20mm; max-width: 64mm; object-fit: contain; margin-bottom: 2mm; }
      .titulo {
        font-size: 40pt; font-weight: 700; line-height: 1; color: ${forte};
        text-transform: uppercase; letter-spacing: 0.22em; margin-right: -0.22em;
      }
      .subtitulo {
        font-size: 15pt; font-style: italic; color: ${forte}; margin-top: 1.5mm;
      }
      .fio { display: block; width: 64mm; height: 3.2mm; margin: 2.5mm auto 0; }
      main { flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
      .certificamos { font-size: 14pt; font-style: italic; color: #4a4a5c; }
      .nome {
        font-size: 30pt; font-weight: 700; font-style: italic; margin: 2mm auto 4mm;
        padding: 0 10mm 2mm; border-bottom: 0.3mm solid ${media};
        max-width: 215mm; line-height: 1.15;
      }
      .texto { font-size: 14pt; line-height: 1.5; margin: 0 auto; max-width: 205mm; color: #2c2c3a; }
      footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 8mm; }
      .assinaturas { display: flex; gap: 14mm; flex: 1; justify-content: center; }
      .assinatura { width: 64mm; text-align: center; }
      .tracado { height: 15mm; display: flex; align-items: flex-end; justify-content: center; }
      .tracado img { max-height: 15mm; max-width: 58mm; object-fit: contain; }
      .linha { border-top: 0.3mm solid #1d1d27; margin-top: 1mm; }
      .quem { font-size: 11pt; font-weight: 700; margin-top: 1.5mm; }
      .cargo { font-size: 10pt; font-style: italic; color: #4a4a5c; }
      .autenticidade { display: flex; align-items: center; gap: 2.5mm; }
      .qr { width: 18mm; height: 18mm; flex-shrink: 0; }
      .qr svg { width: 100%; height: 100%; display: block; }
      .codigo { font-size: 7.5pt; color: #4a4a5c; line-height: 1.4; max-width: 44mm; }
      .codigo strong { color: #1d1d27; letter-spacing: 0.06em; }
      .url { word-break: break-all; }
    `,
    moldura(forte, media) + paginas,
  );
}
