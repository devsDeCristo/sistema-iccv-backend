import { InternalServerErrorException } from '@nestjs/common';
import * as puppeteer from 'puppeteer-core';

/**
 * Um Chrome só, aberto na primeira geração e reaproveitado pelas seguintes.
 *
 * Abrir o navegador custava ~250ms por PDF — metade do tempo de um crachá
 * avulso com as imagens já em cache. Cada geração abre e fecha só a própria
 * página. Sem página aberta por `OCIOSO_MS`, o Chrome fecha, para não segurar
 * memória num servidor que passa horas sem gerar PDF.
 */
const OCIOSO_MS = 60_000;

let compartilhado: Promise<puppeteer.Browser> | undefined;
let paginasAbertas = 0;
let ocioso: NodeJS.Timeout | undefined;

/**
 * O `puppeteer-core` não traz navegador. Com `PUPPETEER_EXECUTABLE_PATH`
 * ele usa esse binário — é o caso do Docker, que instala o Chromium em
 * `/usr/bin/chromium`. Sem a variável, procura o Google Chrome instalado
 * no lugar padrão do sistema, que é o caso de quem roda na própria máquina.
 */
function lancar() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;

  return puppeteer
    .launch({
      ...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // o /dev/shm do Docker tem 64 MB; página grande estourava ali e
        // derrubava o Chrome. Com a opção, ele usa o /tmp
        '--disable-dev-shm-usage',
      ],
    })
    .catch((error: Error) => {
      throw new InternalServerErrorException(
        `Não foi possível abrir o navegador para gerar o PDF (${error.message}). ` +
          'Instale o Google Chrome ou defina PUPPETEER_EXECUTABLE_PATH no .env.',
      );
    });
}

/**
 * Garante o Chrome aberto, sem abrir página. Serve para lançá-lo em paralelo
 * com o download das imagens, na primeira geração.
 */
export function prepararNavegador(): Promise<puppeteer.Browser> {
  compartilhado ??= lancar().then(
    (browser) => {
      // Aberto entre gerações, o Chrome sobreviveria ao processo que o abriu
      // (restart do `nest --watch`, script que termina): no `exit` ele morre
      // junto. Tem que ser síncrono — é o único tipo de trabalho que o `exit`
      // ainda executa.
      const matar = () => browser.process()?.kill('SIGKILL');
      process.once('exit', matar);

      // o Chrome caiu ou foi fechado: a próxima geração abre outro
      browser.once('disconnected', () => {
        process.off('exit', matar);
        compartilhado = undefined;
      });
      return browser;
    },
    (erro) => {
      compartilhado = undefined;
      throw erro;
    },
  );

  return compartilhado;
}

/** Uma página no Chrome compartilhado. Quem pede fecha, sempre (`finally`). */
export async function novaPagina(): Promise<puppeteer.Page> {
  const browser = await prepararNavegador();

  clearTimeout(ocioso);
  paginasAbertas++;

  const page = await browser.newPage().catch((erro) => {
    paginasAbertas--;
    throw erro;
  });

  page.once('close', () => {
    paginasAbertas--;
    if (paginasAbertas > 0) return;

    ocioso = setTimeout(() => {
      const fechando = compartilhado;
      compartilhado = undefined;
      fechando?.then((b) => b.close()).catch(() => undefined);
    }, OCIOSO_MS);
    // o relógio de ociosidade não segura o processo aberto (testes, shutdown)
    ocioso.unref();
  });

  return page;
}

/**
 * Serve imagens à página por endereço curto, em vez de data URI no HTML.
 *
 * Imagem que se repete — o fundo, a logo e o papel de cada crachá — ia
 * inteira, em base64, em cada cópia: 340 KB por crachá, e 100 crachás já eram
 * 34 MB de HTML e 1,1 GB de Chrome. Com 300 o Chrome caía, e no container o
 * limite de memória derrubava o processo inteiro, sem deixar erro no log.
 *
 * Aqui cada imagem vira um endereço (`https://pdf.local/fundo`) que a própria
 * página responde, interceptando o pedido: o HTML fica com poucos KB e o
 * Chrome busca e decodifica cada imagem uma vez só, qualquer que seja o número
 * de cópias. Chamar antes do `setContent`. Devolve os endereços, com as mesmas
 * chaves.
 */
export async function servirImagens<
  T extends { [K in keyof T]: string | undefined },
>(page: puppeteer.Page, imagens: T): Promise<T> {
  const recursos = new Map<string, { contentType: string; body: Buffer }>();
  const enderecos: Record<string, string | undefined> = {};

  for (const [nome, dataUri] of Object.entries<string | undefined>(imagens)) {
    const partes = dataUri && /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
    if (!partes) {
      enderecos[nome] = dataUri;
      continue;
    }
    const url = `https://pdf.local/${encodeURIComponent(nome)}`;
    recursos.set(url, {
      contentType: partes[1],
      body: Buffer.from(partes[2], 'base64'),
    });
    enderecos[nome] = url;
  }

  await page.setRequestInterception(true);
  // a interceptação desliga o cache da página; religado, o mesmo endereço em
  // mil `<img>` é um pedido só
  await page.setCacheEnabled(true);
  page.on('request', (pedido) => {
    const recurso = recursos.get(pedido.url());
    if (recurso) {
      pedido.respond({
        status: 200,
        ...recurso,
        headers: { 'Cache-Control': 'max-age=3600' },
      });
    } else {
      pedido.continue();
    }
  });

  return enderecos as T;
}
