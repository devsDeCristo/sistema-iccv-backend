import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import * as puppeteer from 'puppeteer-core';
import { PDFDocument } from 'pdf-lib';
import { PrismaService } from '../prisma';
import { TeamService } from '../team/team.service';
import { Role } from '../auth/roles';
import { isSuperAdmin, perfilNaIgreja, SELECT_TENANT } from '../auth/tenant';
import { quadranteAtivo } from '../event/event-quadrante';
import { prepararImagens } from './quadrante-images';
import {
  cabecalho,
  comFonteEmbutida,
  EquipeDoPdf,
  EventoDoPdf,
  htmlDaCapa,
  htmlDasEquipes,
  rodape,
} from './quadrante-pdf';

const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function formatDateRange(startDate: Date, endDate: Date): string {
  const end = new Date(endDate);
  return `De ${new Date(startDate).getUTCDate()} a ${end.getUTCDate()} de ${
    MESES[end.getUTCMonth()]
  } de ${end.getUTCFullYear()}`;
}

export interface QuadranteUser {
  id: string;
  fullName: string;
  profilePhotoUrl: string | null;
  cellphone: string;
  birthday: Date;
  email: string;
  roleTeam: 'LEADER' | 'MEMBER';
}

export interface QuadranteTeam {
  id: string;
  name: string;
  users: QuadranteUser[];
}

@Injectable()
export class QuadranteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamService: TeamService,
  ) {}

  /** Mesma ordem usada hoje no PDF gerado no frontend: líderes primeiro,
   * depois ordem alfabética. */
  private sortUsers(users: QuadranteUser[]): QuadranteUser[] {
    return [...users].sort((a, b) =>
      a.roleTeam === b.roleTeam
        ? a.fullName.localeCompare(b.fullName)
        : a.roleTeam === 'LEADER'
          ? -1
          : 1,
    );
  }

  /**
   * Quem pode abrir o quadrante. Com ele desligado no evento
   * (`data.showQuadrante`), ninguém — nem o admin: a opção decide se o evento
   * tem quadrante, não só quem o vê. Ligado, abrem o admin da igreja e os
   * inscritos.
   *
   * A rota não passa pelo `EventTenantGuard` porque ele recortaria o admin de
   * outra igreja que está inscrito aqui como qualquer pessoa — e é justamente
   * o caso do inscrito que esta checagem precisa aceitar.
   */
  async assertPodeVer(eventId: string, requesterId?: string): Promise<void> {
    if (!requesterId) {
      throw new ForbiddenException('Usuário não autenticado');
    }

    const [requester, event] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: requesterId },
        select: SELECT_TENANT,
      }),
      this.prisma.event.findUnique({
        where: { id: eventId },
        select: { churchId: true, data: true },
      }),
    ]);

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    if (!quadranteAtivo(event.data)) {
      throw new ForbiddenException(
        'O quadrante está desligado nas configurações deste evento',
      );
    }

    if (
      isSuperAdmin(requester) ||
      perfilNaIgreja(requester, event.churchId) === Role.ADMIN
    ) {
      return;
    }

    const inscricao = await this.prisma.eventOnUsers.findUnique({
      where: { userId_eventId: { userId: requesterId, eventId } },
      select: { userId: true },
    });

    if (!inscricao) {
      throw new ForbiddenException(
        'O quadrante só pode ser visto por quem está inscrito no evento',
      );
    }
  }

  /**
   * O conteúdo do quadrante, para a tela montar a mesma folha do PDF: equipes
   * já na ordem de impressão, e capa, logo e período do rodapé.
   */
  async findQuadrante(eventId: string) {
    const [teams, event] = await Promise.all([
      this.teamService.findAll(eventId) as Promise<QuadranteTeam[]>,
      this.prisma.event.findUnique({
        where: { id: eventId },
        select: { name: true, startDate: true, endDate: true, data: true },
      }),
    ]);

    if (!event) {
      throw new NotFoundException('Evento não encontrado');
    }

    const data = (event.data ?? {}) as Record<string, unknown>;

    return {
      event: {
        name: event.name,
        startDate: event.startDate,
        endDate: event.endDate,
        logoUrl: typeof data.logoUrl === 'string' ? data.logoUrl : null,
        coverUrl: typeof data.coverUrl === 'string' ? data.coverUrl : null,
        // paleta do evento: a tela e o PDF vestem as cores dele
        colors: (data.colors ?? null) as {
          primary?: string;
          secondary?: string;
          tertiary?: string;
        } | null,
        periodo: formatDateRange(event.startDate, event.endDate),
      },
      teams: (teams ?? []).map((team) => ({
        id: team.id,
        name: team.name,
        users: this.sortUsers(team.users),
      })),
    };
  }

  /**
   * Fotos, capa e logo do quadrante, já reduzidas e embutidas: o Chrome não tem
   * nada para baixar — ver `quadrante-images.ts`.
   */
  private imagensDoQuadrante({
    event,
    teams,
  }: Awaited<ReturnType<QuadranteService['findQuadrante']>>) {
    return prepararImagens([
      ...(event.logoUrl
        ? [
            { url: event.logoUrl, formato: 'logo' as const },
            { url: event.logoUrl, formato: 'cabecalho' as const },
          ]
        : []),
      ...(event.coverUrl ? [{ url: event.coverUrl, formato: 'capa' as const }] : []),
      ...teams.flatMap((team) =>
        team.users
          .filter((user) => user.profilePhotoUrl)
          .map((user) => ({ url: user.profilePhotoUrl!, formato: 'foto' as const })),
      ),
    ]);
  }

  /**
   * Começa a baixar as imagens do PDF quando a tela do quadrante abre, sem
   * esperar. O download é quase todo o tempo da geração (~5s num evento de 145
   * fotos, contra ~1,5s do Chrome), e a pessoa sempre passa pela tela antes de
   * clicar em "Baixar PDF": quando clica, as fotos já estão em cache ou a
   * caminho — o PDF pega carona nelas.
   */
  aquecerImagens(quadrante: Awaited<ReturnType<QuadranteService['findQuadrante']>>) {
    this.imagensDoQuadrante(quadrante).catch(() => undefined);
  }

  async generatePdf(
    eventId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const quadrante = await this.findQuadrante(eventId);
    const { event, teams } = quadrante;

    if (!teams.length) {
      throw new BadRequestException(
        'Não é possível gerar o PDF: este evento ainda não possui equipes cadastradas.',
      );
    }

    // o Chrome abre enquanto as fotos chegam: uma coisa não depende da outra
    const [imagens, browser] = await Promise.all([
      this.imagensDoQuadrante(quadrante),
      this.abrirNavegador(),
    ]);

    const evento: EventoDoPdf = {
      name: event.name,
      periodo: event.periodo,
      colors: event.colors,
      logo: event.logoUrl ? imagens.get(`logo:${event.logoUrl}`) : undefined,
      logoDoCabecalho: event.logoUrl
        ? imagens.get(`cabecalho:${event.logoUrl}`)
        : undefined,
      capa: event.coverUrl ? imagens.get(`capa:${event.coverUrl}`) : undefined,
    };

    const equipes: EquipeDoPdf[] = teams.map((team) => ({
      ...team,
      users: team.users.map((user) => ({
        ...user,
        // foto que não baixou sai com as iniciais, igual a quem não tem foto
        profilePhotoUrl: user.profilePhotoUrl
          ? (imagens.get(`foto:${user.profilePhotoUrl}`) ?? null)
          : null,
      })),
    }));

    const totalPessoas = equipes.reduce((soma, e) => soma + e.users.length, 0);

    try {
      const imprimir = async (
        html: string,
        opcoes: Parameters<puppeteer.Page['pdf']>[0] = {},
      ) => {
        const page = await browser.newPage();
        // imagens e fonte já vêm embutidas: não há nada para buscar fora
        await page.setContent(await comFonteEmbutida(html), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          ...opcoes,
        });
        await page.close();
        return pdf;
      };

      // capa e equipes saem separadas e são juntadas: o cabeçalho do Puppeteer
      // vai em toda página, e a capa precisa sair limpa — ver `quadrante-pdf.ts`
      const [capa, paginas] = await Promise.all([
        imprimir(
          htmlDaCapa(evento, { equipes: equipes.length, pessoas: totalPessoas }),
        ),
        imprimir(htmlDasEquipes(evento, equipes), {
          displayHeaderFooter: true,
          headerTemplate: cabecalho(evento),
          footerTemplate: rodape(evento),
        }),
      ]);

      const final = await PDFDocument.create();
      final.setTitle(`Quadrante · ${event.name}`);
      for (const parte of [capa, paginas]) {
        const doc = await PDFDocument.load(parte);
        const copiadas = await final.copyPages(doc, doc.getPageIndices());
        copiadas.forEach((pagina) => final.addPage(pagina));
      }

      const slug = event.name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();

      return {
        buffer: Buffer.from(await final.save()),
        fileName: `quadrante-${slug || 'evento'}.pdf`,
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * O `puppeteer-core` não traz navegador. Com `PUPPETEER_EXECUTABLE_PATH`
   * ele usa esse binário — é o caso do Docker, que instala o Chromium em
   * `/usr/bin/chromium`. Sem a variável, procura o Google Chrome instalado
   * no lugar padrão do sistema, que é o caso de quem roda na própria máquina.
   */
  private abrirNavegador() {
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
}
