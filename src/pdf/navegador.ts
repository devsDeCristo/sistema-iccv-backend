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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
