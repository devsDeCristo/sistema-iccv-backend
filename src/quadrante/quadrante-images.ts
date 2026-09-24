import * as sharp from 'sharp';

/**
 * Imagens do quadrante, prontas para o Puppeteer.
 *
 * As fotos são os originais do Firebase: um evento real tinha 145 fotos
 * distintas somando 64 MB, com arquivo de 2 MB para um quadrinho de 50×65. O
 * Chrome esperava baixar tudo antes de imprimir e estourava os 30s; disparando
 * tudo de uma vez, parte dos downloads ainda falhava.
 *
 * Aqui o servidor baixa com concorrência limitada, reduz cada imagem ao tamanho
 * em que ela sai no papel e entrega como data URI — o HTML chega ao Chrome sem
 * nada para buscar. As mesmas 145 fotos viram ~850 KB.
 */

/** Downloads ao mesmo tempo: mais que isso o Firebase começa a derrubar. */
const CONCORRENCIA = 8;

/** Por imagem. Foto que não chega a tempo sai como o quadro cinza vazio. */
const TIMEOUT_MS = 10_000;

/**
 * Cache em memória por URL. A URL do Firebase muda quando a foto é trocada
 * (token novo), então foto antiga em cache nunca é servida no lugar da nova. O
 * teto só impede o processo de crescer sem limite: ~6 KB por foto.
 */
const LIMITE_DO_CACHE = 3000;
const cache = new Map<string, string>();

function guardar(chave: string, valor: string) {
  if (cache.size >= LIMITE_DO_CACHE) {
    // o Map mantém a ordem de inserção: a primeira chave é a mais antiga
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(chave, valor);
}

export type FormatoDeImagem = 'foto' | 'capa' | 'logo';

/** Tamanho em pixels de cada uso, com folga para a impressão (~2×). */
const FORMATOS: Record<FormatoDeImagem, (img: sharp.Sharp) => sharp.Sharp> = {
  foto: (img) =>
    img.resize(150, 195, { fit: 'cover' }).jpeg({ quality: 78 }),
  capa: (img) =>
    img
      .resize(2000, 1400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }),
  // a logo costuma ter fundo transparente: continua PNG
  logo: (img) =>
    img
      .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
      .png(),
};

async function baixarReduzida(
  url: string,
  formato: FormatoDeImagem,
): Promise<string | null> {
  const chave = `${formato}:${url}`;
  const emCache = cache.get(chave);
  if (emCache) return emCache;

  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);

  try {
    const resposta = await fetch(url, { signal: controle.signal });
    if (!resposta.ok) return null;

    const original = Buffer.from(await resposta.arrayBuffer());
    // `rotate()` sem argumento aplica a orientação do EXIF: foto de celular
    // deitada no arquivo sai em pé
    const reduzida = await FORMATOS[formato](sharp(original).rotate()).toBuffer();
    const mime = formato === 'logo' ? 'image/png' : 'image/jpeg';
    const dataUri = `data:${mime};base64,${reduzida.toString('base64')}`;

    guardar(chave, dataUri);
    return dataUri;
  } catch {
    // URL velha, arquivo apagado, timeout, imagem corrompida: sai sem foto
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Baixa e reduz as imagens pedidas, no máximo `CONCORRENCIA` por vez. Devolve
 * URL original → data URI; a que falhou fica de fora do mapa.
 */
export async function prepararImagens(
  pedidos: { url: string; formato: FormatoDeImagem }[],
): Promise<Map<string, string>> {
  const unicos = [
    ...new Map(pedidos.map((p) => [`${p.formato}:${p.url}`, p])).values(),
  ];
  const resultado = new Map<string, string>();
  let proximo = 0;

  async function trabalhador() {
    while (proximo < unicos.length) {
      const { url, formato } = unicos[proximo++];
      const dataUri = await baixarReduzida(url, formato);
      if (dataUri) resultado.set(`${formato}:${url}`, dataUri);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCORRENCIA, unicos.length) }, trabalhador),
  );

  return resultado;
}
