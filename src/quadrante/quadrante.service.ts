import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as puppeteer from 'puppeteer-core';
import { PrismaService } from '../prisma';
import { TeamService } from '../team/team.service';

/** Mesmo propósito do `escapeHtml` de `password-reset.service.ts` /
 * `event.service.ts`: nomes e observações vão direto para dentro do HTML que
 * o Puppeteer imprime, então precisam ser escapados antes. */
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char] ?? char,
  );
}

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

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

interface QuadranteUser {
  id: string;
  fullName: string;
  profilePhotoUrl: string | null;
  cellphone: string;
  birthday: Date;
  email: string;
  roleTeam: 'LEADER' | 'MEMBER';
}

interface QuadranteTeam {
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

  private renderCard(user: QuadranteUser): string {
    // a moldura cinza é do container, não da <img>: foto ausente e foto que
    // falha no download (URL antiga, arquivo removido) caem no mesmo quadro
    // vazio, em vez do ícone de imagem quebrada
    const photo = user.profilePhotoUrl
      ? `<img src="${escapeHtml(user.profilePhotoUrl)}" alt="" onerror="this.remove()" />`
      : '';

    return `
      <div class="card">
        <div class="photo">${photo}</div>
        <div class="info">
          <div class="name">${escapeHtml(user.fullName)}</div>
          <div>Data Nasc: ${formatDate(user.birthday)}</div>
          <div>Email: ${escapeHtml(user.email)}</div>
          <div>Celular: ${escapeHtml(user.cellphone)}</div>
        </div>
      </div>`;
  }

  private renderTeam(team: QuadranteTeam): string {
    const cards = this.sortUsers(team.users).map((u) => this.renderCard(u)).join('');

    return `
      <section class="team">
        <h2 class="team-title">${escapeHtml(team.name)}</h2>
        <div class="grid">${cards}</div>
      </section>`;
  }

  private renderCover(logoUrl?: string, coverUrl?: string): string {
    if (!coverUrl && !logoUrl) return '';

    const bg = coverUrl
      ? `<img class="cover-bg" src="${escapeHtml(coverUrl)}" alt="" />`
      : '';
    const logo = logoUrl
      ? `<img class="cover-logo" src="${escapeHtml(logoUrl)}" alt="" />`
      : '';

    return `<section class="cover">${bg}${logo}</section>`;
  }

  async buildHtml(
    eventId: string,
  ): Promise<{ html: string; eventName: string; periodo: string }> {
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

    if (!teams?.length) {
      throw new BadRequestException(
        'Não é possível gerar o PDF: este evento ainda não possui equipes cadastradas.',
      );
    }

    const data = (event.data ?? {}) as Record<string, unknown>;
    const logoUrl = typeof data.logoUrl === 'string' ? data.logoUrl : undefined;
    const coverUrl = typeof data.coverUrl === 'string' ? data.coverUrl : undefined;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; font-family: Helvetica, Arial, sans-serif; color: #000; }
            .cover {
              position: relative;
              width: 100%;
              height: 100vh;
              page-break-after: always;
              background-color: #1c0f4d;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .cover-bg {
              position: absolute;
              inset: 0;
              width: 100%;
              height: 100%;
              object-fit: cover;
            }
            .cover-logo {
              position: relative;
              max-width: 55%;
              max-height: 55%;
              object-fit: contain;
            }
            .content { padding: 16px 20px 28px; }
            .team { break-inside: auto; margin-bottom: 24px; }
            /* break-after: título de equipe no pé da página, com o quadro só
               na página seguinte, é o caso que mais atrapalha na hora de usar */
            .team-title { font-size: 16px; margin: 0 0 10px; break-after: avoid; }
            .grid {
              display: grid;
              grid-template-columns: repeat(4, 1fr);
              gap: 10px;
            }
            .card {
              border: 1px solid #000;
              padding: 4px;
              display: flex;
              flex-direction: row;
              break-inside: avoid;
              font-size: 8px;
            }
            .photo {
              width: 50px;
              height: 65px;
              margin-right: 6px;
              flex-shrink: 0;
              background-color: #ededed;
            }
            .photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
            .info { display: flex; flex-direction: column; justify-content: center; gap: 3px; }
            .name { font-size: 9px; font-weight: bold; }
          </style>
        </head>
        <body>
          ${this.renderCover(logoUrl, coverUrl)}
          <div class="content">
            ${teams.map((team) => this.renderTeam(team)).join('')}
          </div>
        </body>
      </html>`;

    return {
      html,
      eventName: event.name,
      periodo: formatDateRange(event.startDate, event.endDate),
    };
  }

  async generatePdf(
    eventId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { html, eventName, periodo } = await this.buildHtml(eventId);

    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      // 'load' espera as imagens remotas (fotos, logo, capa) carregarem antes
      // de imprimir — sem isso o PDF sai com fotos quebradas.
      await page.setContent(html, { waitUntil: 'load' });

      const buffer = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `<div style="font-size: 9px; width: 100%; text-align: center; color: #555;">${escapeHtml(
          periodo,
        )}</div>`,
        margin: { top: '10mm', bottom: '16mm', left: '10mm', right: '10mm' },
      });

      const slug = eventName
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();

      return { buffer: Buffer.from(buffer), fileName: `quadrante-${slug || 'evento'}.pdf` };
    } finally {
      await browser.close();
    }
  }
}
