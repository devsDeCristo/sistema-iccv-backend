import { InternalServerErrorException } from '@nestjs/common';
import * as puppeteer from 'puppeteer-core';

/**
 * O `puppeteer-core` não traz navegador. Com `PUPPETEER_EXECUTABLE_PATH`
 * ele usa esse binário — é o caso do Docker, que instala o Chromium em
 * `/usr/bin/chromium`. Sem a variável, procura o Google Chrome instalado
 * no lugar padrão do sistema, que é o caso de quem roda na própria máquina.
 */
export function abrirNavegador() {
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
