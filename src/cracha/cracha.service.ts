import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma';
import { embutirFonte } from '../pdf/fonte';
import { prepararImagens, reduzir } from '../pdf/imagens';
import { novaPagina, prepararNavegador } from '../pdf/navegador';
import {
  ArtesDoCracha,
  htmlDosCrachas,
  montarFolhas,
  qrDoCracha,
  URL_DA_FONTE,
} from './cracha-pdf';
import { GerarCrachasDto } from './dto/gerar-crachas.dto';

/** Teto por geração: acima disso é engano, não um evento de verdade */
const LIMITE_DE_CRACHAS = 3000;

/**
 * As artes fixas do crachá, lidas do disco e reduzidas uma vez por processo.
 *
 * Moram em `src/cracha/assets` e são lidas pelo `process.cwd()`, como os
 * templates de e-mail — por isso o Dockerfile copia a pasta para a imagem.
 */
let artesFixas:
  | Promise<
      Pick<ArtesDoCracha, 'logoDaIgreja' | 'papel'> & { capaPadrao: string }
    >
  | undefined;

function carregarArtesFixas() {
  const ler = (arquivo: string) =>
    fs.readFile(path.join(process.cwd(), 'src', 'cracha', 'assets', arquivo));

  artesFixas ??= (async () => {
    const [logoDaIgreja, papel, capaPadrao] = await Promise.all([
      ler('logo-igreja.png').then((b) => reduzir(b, 'cabecalho')),
      ler('papel-rasgado.png').then((b) => reduzir(b, 'crachaPapel')),
      // a capa padrão de evento — a mesma da página e dos cartões do evento
      ler('capa-padrao.jpg').then((b) => reduzir(b, 'crachaFundo')),
    ]);
    return { logoDaIgreja, papel, capaPadrao };
  })().catch((erro) => {
    artesFixas = undefined;
    throw erro;
  });

  return artesFixas;
}

/** Capa e logo do evento, no `data` que vem do banco */
function imagensDoEvento(data: unknown) {
  const campos = (data ?? {}) as Record<string, unknown>;
  return {
    capaUrl: typeof campos.coverUrl === 'string' ? campos.coverUrl : null,
    logoUrl: typeof campos.logoUrl === 'string' ? campos.logoUrl : null,
  };
}

function baixarImagens({
  capaUrl,
  logoUrl,
}: ReturnType<typeof imagensDoEvento>) {
  return prepararImagens([
    ...(capaUrl ? [{ url: capaUrl, formato: 'crachaFundo' as const }] : []),
    ...(logoUrl ? [{ url: logoUrl, formato: 'crachaLogo' as const }] : []),
  ]);
}

/**
 * Começa a baixar o que o crachá do evento vai usar, sem esperar: capa e logo
 * do Firebase (~1,6s juntas, quase todo o tempo do primeiro crachá), as artes
 * fixas e a fonte. Chamado quando o admin abre o painel do evento — de onde o
 * crachá é baixado —, e o clique em "Baixar Crachá" encontra tudo em cache.
 */
export function aquecerImagensDoCracha(data: unknown) {
  baixarImagens(imagensDoEvento(data)).catch(() => undefined);
  carregarArtesFixas().catch(() => undefined);
  embutirFonte('', URL_DA_FONTE).catch(() => undefined);
}

@Injectable()
export class CrachaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crachás do evento em PDF, gerados pelo Chrome no servidor.
   *
   * O fundo é a capa do evento; sem capa, a capa padrão de evento do sistema.
   * A logo é a do evento; sem logo, o espaço fica vazio. Antes, no react-pdf,
   * qualquer uma das duas que faltasse virava uma arte fixa de outro evento.
   */
  async gerarPdf(
    eventId: string,
    dto: GerarCrachasDto,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, data: true },
    });

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    const brancos = dto.blankCount ?? 0;
    const comQr = dto.withQrCode ?? true;
    const secoes = dto.sections.map((secao) => ({
      titulo: secao.title?.trim() ? secao.title.trim().toLowerCase() : null,
      crachas: secao.badges.map((cracha) => ({
        nome: cracha.name,
        qr: comQr ? qrDoCracha(cracha.userId) : null,
      })),
    }));

    const total =
      secoes.reduce((soma, secao) => soma + secao.crachas.length, 0) + brancos;

    if (!total) {
      throw new BadRequestException('Nenhum crachá para gerar');
    }
    if (total > LIMITE_DE_CRACHAS) {
      throw new BadRequestException(
        `São no máximo ${LIMITE_DE_CRACHAS} crachás por PDF`,
      );
    }

    const urls = imagensDoEvento(event.data);
    const { capaUrl, logoUrl } = urls;

    // capa, logo, artes fixas e o Chrome ao mesmo tempo: nada depende de nada
    const [imagens, fixas] = await Promise.all([
      baixarImagens(urls),
      carregarArtesFixas(),
      prepararNavegador(),
    ]);

    const page = await novaPagina();
    try {
      const artes: ArtesDoCracha = {
        // capa que não baixou cai na padrão, como evento sem capa
        fundo:
          (capaUrl && imagens.get(`crachaFundo:${capaUrl}`)) ||
          fixas.capaPadrao,
        logoDaIgreja: fixas.logoDaIgreja,
        papel: fixas.papel,
        logoDoEvento: logoUrl
          ? imagens.get(`crachaLogo:${logoUrl}`)
          : undefined,
      };

      const html = await embutirFonte(
        htmlDosCrachas(montarFolhas(secoes, brancos), artes),
        URL_DA_FONTE,
      );

      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const pdf = await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
      });

      const slug = event.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();

      return {
        buffer: Buffer.from(pdf),
        fileName: `crachas-${slug || 'evento'}.pdf`,
      };
    } finally {
      await page.close();
    }
  }
}
