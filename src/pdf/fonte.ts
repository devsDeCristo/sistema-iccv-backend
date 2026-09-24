/**
 * Fonte do Google embutida no HTML do Puppeteer, em vez do `<link>`.
 *
 * Com o link, o Chrome buscava a folha e os arquivos no Google a cada
 * impressão — ~500ms em cada uma. Aqui cada folha é baixada uma vez por
 * processo e reaproveitada. Se o Google não responder, o `<link>` fica como
 * estava, e o Chrome tenta sozinho (ou cai na fonte de reserva do CSS).
 */

/** O `<link>` que o HTML carrega; é ele que `embutirFonte` troca */
export function linkDaFonte(url: string): string {
  return `<link rel="stylesheet" href="${url}" />`;
}

const cache = new Map<string, Promise<string | null>>();

async function baixarFonte(url: string): Promise<string | null> {
  const buscar = async (endereco: string, headers?: Record<string, string>) => {
    const resposta = await fetch(endereco, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!resposta.ok) throw new Error(`${resposta.status} em ${endereco}`);
    return resposta;
  };

  try {
    // o Google só entrega woff2 para quem se apresenta como navegador moderno
    const css = await (
      await buscar(url, {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      })
    ).text();

    const arquivos = [
      ...new Set(css.match(/https:\/\/fonts\.gstatic\.com[^)]+/g) ?? []),
    ];
    const embutidos = await Promise.all(
      arquivos.map(async (arquivo) => {
        const dados = Buffer.from(await (await buscar(arquivo)).arrayBuffer());
        return [arquivo, `data:font/woff2;base64,${dados.toString('base64')}`];
      }),
    );

    return `<style>${embutidos.reduce(
      (folha, [arquivo, dataUri]) => folha.split(arquivo).join(dataUri),
      css,
    )}</style>`;
  } catch {
    // não guarda a falha: a próxima geração tenta de novo
    cache.delete(url);
    return null;
  }
}

/** Troca o `<link>` da fonte `url` no HTML pela fonte embutida, quando dá */
export async function embutirFonte(html: string, url: string): Promise<string> {
  if (!cache.has(url)) cache.set(url, baixarFonte(url));
  const estilo = await cache.get(url);
  return estilo ? html.replace(linkDaFonte(url), estilo) : html;
}
