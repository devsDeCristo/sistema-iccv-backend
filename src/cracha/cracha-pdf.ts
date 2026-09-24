/**
 * Layout do PDF de crachás: quatro por folha A4, 8,7 × 11 cm cada.
 *
 * É o mesmo desenho do crachá que o front montava com o react-pdf, medida por
 * medida — fundo, logo da igreja, logo do evento, o papel rasgado e o nome com o
 * QR dentro do rasgo. Os números em pt vêm de lá e estão explicados onde são
 * usados.
 *
 * Tudo aqui é HTML em texto: nome e título passam por `escapeHtml`.
 */
import * as QRCode from 'qrcode';
import { escapeHtml } from '../quadrante/quadrante-pdf';
import { linkDaFonte } from '../pdf/fonte';

/**
 * O nome sai em Arimo, que tem as medidas da Helvetica em que o react-pdf o
 * desenhava; o título da folha, em Oswald, que era a fonte registrada lá.
 * Embutidas pelo servidor: no Docker não há Helvetica instalada.
 */
export const URL_DA_FONTE =
  'https://fonts.googleapis.com/css2?family=Arimo:wght@700&family=Oswald:wght@400&display=block';

const POR_FOLHA = 4;

export interface CrachaDoPdf {
  nome: string;
  /** o `<svg>` pronto, ou `null` sem QR (opção do modal, id inválido, em branco) */
  qr: string | null;
}

export interface FolhaDeCrachas {
  titulo: string | null;
  crachas: CrachaDoPdf[];
}

/** data URIs já reduzidos — ver `src/pdf/imagens.ts` */
export interface ArtesDoCracha {
  fundo: string;
  logoDaIgreja: string;
  papel: string;
  /** ausente quando o evento não tem logo: o espaço fica vazio */
  logoDoEvento?: string;
}

/**
 * O código do QR: o id do inscrito em hex maiúsculo, sem hífen — o mesmo que o
 * leitor do check-in espera (`buildBadgeCode` no front). Só dígito e letra
 * maiúscula cabem no modo alfanumérico, que deixa o QR com 25 módulos em vez de
 * 33: módulo maior no mesmo tamanho impresso, que é o que a câmera precisa.
 */
export function codigoDoCracha(userId?: string): string {
  const hex = (userId ?? '').replace(/-/g, '').toUpperCase();
  // fora de um uuid não vira código: melhor crachá sem QR que QR que não casa
  // com ninguém
  return /^[0-9A-F]{32}$/.test(hex) ? hex : '';
}

/**
 * QR em vetor, nível M e margem de 2 módulos — os mesmos parâmetros do
 * `qrcode.react` que o front usava. A margem é a zona de silêncio: o código
 * encosta na arte do crachá, e sem ela o leitor não engata.
 */
export function qrDoCracha(userId?: string): string | null {
  const codigo = codigoDoCracha(userId);
  if (!codigo) return null;

  const { modules } = QRCode.create(codigo, { errorCorrectionLevel: 'M' });
  const margem = 2;
  const lado = modules.size + margem * 2;

  let d = '';
  for (let linha = 0; linha < modules.size; linha++) {
    for (let coluna = 0; coluna < modules.size; coluna++) {
      if (modules.get(linha, coluna)) {
        d += `M${coluna + margem},${linha + margem}h1v1h-1z`;
      }
    }
  }

  return `<svg class="qr" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`;
}

function emPedacos<T>(itens: T[], tamanho: number): T[][] {
  const pedacos: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    pedacos.push(itens.slice(i, i + tamanho));
  }
  return pedacos;
}

/**
 * Cada seção começa em folha nova, para o cabeçalho valer para todos os
 * crachás dela; os em branco vão para o fim, sem cabeçalho.
 */
export function montarFolhas(
  secoes: { titulo: string | null; crachas: CrachaDoPdf[] }[],
  brancos: number,
): FolhaDeCrachas[] {
  const folhas: FolhaDeCrachas[] = [];

  for (const secao of secoes) {
    for (const crachas of emPedacos(secao.crachas, POR_FOLHA)) {
      folhas.push({ titulo: secao.titulo, crachas });
    }
  }

  const vazios = Array.from({ length: brancos }, () => ({
    nome: '',
    qr: null,
  }));
  for (const crachas of emPedacos(vazios, POR_FOLHA)) {
    folhas.push({ titulo: null, crachas });
  }

  return folhas;
}

function htmlDoCracha(cracha: CrachaDoPdf, artes: ArtesDoCracha): string {
  return `
    <div class="cracha">
      <img class="fundo" src="${artes.fundo}" alt="" />
      <div class="topo">
        <img class="logo-igreja" src="${artes.logoDaIgreja}" alt="" />
        <div class="logo-evento">${
          artes.logoDoEvento ? `<img src="${artes.logoDoEvento}" alt="" />` : ''
        }</div>
        <img class="papel" src="${artes.papel}" alt="" />
      </div>
      <div class="nome-area${cracha.qr ? '' : ' sem-qr'}">
        <div class="nome">${escapeHtml(cracha.nome)}</div>
        ${cracha.qr ?? ''}
      </div>
    </div>`;
}

export function htmlDosCrachas(
  folhas: FolhaDeCrachas[],
  artes: ArtesDoCracha,
): string {
  const corpo = folhas
    .map((folha) => {
      // a folha incompleta leva lugares vazios: com `space-between`, o crachá
      // sozinho na linha iria para o canto errado
      const lugaresVazios = POR_FOLHA - folha.crachas.length;

      return `
        <section class="folha">
          ${
            folha.titulo
              ? `<div class="titulo">${escapeHtml(folha.titulo)}</div>`
              : ''
          }
          <div class="grade">
            ${folha.crachas
              .map((cracha) => htmlDoCracha(cracha, artes))
              .join('')}
            ${'<div class="cracha vazio"></div>'.repeat(lugaresVazios)}
          </div>
        </section>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    ${linkDaFonte(URL_DA_FONTE)}
    <style>
      @page { size: A4; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; }
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      .folha {
        width: 210mm;
        height: 297mm;
        padding: 15pt;
        overflow: hidden;
        break-after: page;
      }
      .folha:last-child { break-after: auto; }
      .titulo {
        font-family: 'Oswald', sans-serif;
        font-size: 11pt;
        line-height: 1.2;
        color: #555555;
        text-transform: lowercase;
        margin: 0 0 6pt;
        padding-left: 2pt;
      }
      .grade {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
      }

      .cracha {
        position: relative;
        width: 8.7cm;
        height: 11cm;
        margin-bottom: 10pt;
        overflow: hidden;
        border: 1px solid #dbdbdb;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
      }
      .cracha.vazio { border: none; }
      .fundo {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      /* o topo fica centrado na altura do crachá, como no react-pdf: é essa
         posição que põe o rasgo do papel onde o nome é desenhado */
      .topo {
        position: relative;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .logo-igreja { height: 30pt; }
      /* a caixa da logo tem altura fixa com ou sem logo: sem ela o papel
         subiria 105pt e o nome sairia fora do rasgo */
      .logo-evento {
        height: 100pt;
        margin-top: 5pt;
        /* largura definida: sem ela o 70% da logo era calculado sobre ela
           mesma, e a redução se aplicava duas vezes */
        width: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      /* a logo ocupa 80% da caixa, centrada nela: é a caixa, e não a logo, que
         segura o papel no lugar */
      .logo-evento img { height: 80%; max-width: 80%; object-fit: contain; }
      .papel {
        width: 100%;
        height: 140pt;
        object-fit: cover;
        opacity: 0.8;
      }

      /*
       * Nome e QR centralizados dentro do rasgo do papel. A faixa clara do rasgo
       * vai de 177,1pt a 273,6pt — centro em 225,4pt. Com QR o conjunto tem 82pt
       * (24 do nome + 6 + 52 do QR), então o topo fica em 225,4 - 41 ≈ 184, e 190
       * dá o respiro que o nome pede. Sem QR é só o nome: 225,4 - 12 ≈ 213.
       */
      .nome-area {
        position: absolute;
        top: 190pt;
        left: 0;
        right: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .nome-area.sem-qr { top: 213pt; }
      .nome {
        width: 100%;
        font-family: 'Arimo', 'Helvetica Neue', Helvetica, Arial, sans-serif;
        font-weight: 700;
        font-size: 20pt;
        line-height: 1.2;
        text-align: center;
        color: #000;
      }
      /* 52pt para 29 células dá ~0,63mm por módulo, o piso para leitura por
         câmera */
      .qr { width: 52pt; height: 52pt; margin-top: 6pt; display: block; }
    </style>
  </head>
  <body>${corpo}</body>
</html>`;
}
