import * as sharp from 'sharp';

/**
 * Imagens dos PDFs (quadrante e crachá), prontas para o Puppeteer.
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

/**
 * Downloads ao mesmo tempo. O tempo aqui é latência do Firebase (~1s por foto,
 * qualquer que seja o tamanho), não banda: num evento de 145 fotos, 8 por vez
 * levava 19s e 32 por vez leva 5s, sem nenhuma falha. O que derrubava
 * download era o Chrome disparando as 145 de uma vez, não 32.
 */
const CONCORRENCIA = 32;

/** Por imagem. Foto que não chega a tempo sai como o quadro cinza vazio. */
const TIMEOUT_MS = 10_000;

/**
 * Cache em memória por URL. A URL do Firebase muda quando a foto é trocada
 * (token novo), então foto antiga em cache nunca é servida no lugar da nova. O
 * teto só impede o processo de crescer sem limite: ~6 KB por foto.
 *
 * Guarda a promessa, e não o resultado: a tela do quadrante começa os downloads
 * quando abre, e o clique em "Baixar PDF" logo depois pega carona nos que ainda
 * estão a caminho em vez de baixar tudo de novo.
 */
const LIMITE_DO_CACHE = 3000;
const cache = new Map<string, Promise<string | null>>();

function guardar(chave: string, valor: Promise<string | null>) {
  if (cache.size >= LIMITE_DO_CACHE) {
    // o Map mantém a ordem de inserção: a primeira chave é a mais antiga
    cache.delete(cache.keys().next().value as string);
  }
  cache.set(chave, valor);
}

export type FormatoDeImagem =
  | 'foto'
  | 'capa'
  | 'logo'
  | 'cabecalho'
  | 'crachaFundo'
  | 'crachaLogo'
  | 'crachaPapel';

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
  // A mesma logo, na altura em que sai no cabeçalho (7mm; 160px é ~580 dpi).
  // O Chrome embute a imagem do cabeçalho de novo em cada página: com a logo
  // da capa ali, um quadrante de 15 páginas carregava 2 MB só de logo repetida.
  cabecalho: (img) =>
    img.resize({ height: 160, withoutEnlargement: true }).png(),
  // crachá: 8,7 × 11 cm. A capa vai inteira atrás, cortada no formato dele
  crachaFundo: (img) =>
    img.resize(700, 880, { fit: 'cover' }).jpeg({ quality: 80 }),
  // a logo sai com 100pt (35mm) de altura no crachá
  crachaLogo: (img) =>
    img
      .resize(800, 420, { fit: 'inside', withoutEnlargement: true })
      .png(),
  // O papel rasgado já cortado no formato em que aparece (8,7cm × 140pt): o
  // original é bem mais largo, e o `cover` do CSS jogava as laterais fora
  // depois de o Chrome ter embutido tudo no PDF.
  crachaPapel: (img) => img.resize(900, 512, { fit: 'cover' }).png(),
};

const EM_PNG: FormatoDeImagem[] = [
  'logo',
  'cabecalho',
  'crachaLogo',
  'crachaPapel',
];

/** Reduz um arquivo que já está em mãos (as artes fixas do crachá) */
export async function reduzir(
  original: Buffer,
  formato: FormatoDeImagem,
): Promise<string> {
  const reduzida = await FORMATOS[formato](sharp(original).rotate()).toBuffer();
  const mime = EM_PNG.includes(formato) ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${reduzida.toString('base64')}`;
}

function baixarReduzida(
  url: string,
  formato: FormatoDeImagem,
): Promise<string | null> {
  const chave = `${formato}:${url}`;
  const emCache = cache.get(chave);
  if (emCache) return emCache;

  const pendente = baixar(url, formato).then((dataUri) => {
    // falha não fica guardada: a foto que não veio agora tenta de novo na
    // próxima geração, em vez de sair com as iniciais até o servidor reiniciar
    if (!dataUri) cache.delete(chave);
    return dataUri;
  });

  guardar(chave, pendente);
  return pendente;
}

async function baixar(
  url: string,
  formato: FormatoDeImagem,
): Promise<string | null> {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);

  try {
    const resposta = await fetch(url, { signal: controle.signal });
    if (!resposta.ok) return null;

    // `rotate()` sem argumento, em `reduzir`, aplica a orientação do EXIF:
    // foto de celular deitada no arquivo sai em pé
    return await reduzir(Buffer.from(await resposta.arrayBuffer()), formato);
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
