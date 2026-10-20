import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CheckinStatus, Prisma } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { PrismaService } from '../prisma';
import { embutirFonte } from '../pdf/fonte';
import { prepararImagens } from '../pdf/imagens';
import { novaPagina, prepararNavegador } from '../pdf/navegador';
import {
  AssinaturaDoCertificado,
  CertificadoDoPdf,
  EventoDoCertificado,
  URL_DA_FONTE_DO_CERTIFICADO,
  htmlDosCertificados,
} from './certificado-pdf';
import {
  eventoTerminou,
  horaDeChegada,
  hojePorExtenso,
  novoCodigo,
  periodoPorExtenso,
} from './certificado-regras';

/**
 * Certificados por impressão. Como nos crachás, o Chrome segura tudo o que
 * montou até o `pdf()` terminar: em partes, o pico de memória é o de uma parte.
 */
const POR_PARTE = 50;

/** Quem conta como presente: o crachá saiu na recepção (etapa 1 em diante) */
const PRESENTE = { status: { not: CheckinStatus.PENDING } };

const urlDeVerificacao = (codigo: string) =>
  `${(process.env.URL_FRONTEND ?? '').replace(
    /\/$/,
    '',
  )}/certificado/${codigo}`;

const slug = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'evento';

/**
 * Certificado de participação e lista de presença, a partir do check-in.
 *
 * Tem direito ao certificado quem fez check-in (crachá entregue na recepção).
 * O participante baixa o dele depois que o evento termina; o painel gera os de
 * todos os presentes a qualquer hora. Cada certificado leva um código e um QR
 * que abrem a página pública de verificação.
 */
@Injectable()
export class CertificadoService {
  constructor(private readonly prisma: PrismaService) {}

  /** A configuração do certificado (desligado, se nunca foi salvo) */
  async config(eventId: string) {
    const config = await this.prisma.eventCertificate.findUnique({
      where: { eventId },
    });

    return {
      enabled: config?.enabled ?? false,
      workload: config?.workload ?? null,
      signers: (config?.signers ?? []) as unknown as AssinaturaDoCertificado[],
    };
  }

  /** O evento, com o que o certificado e a lista precisam dele */
  private async evento(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        name: true,
        startDate: true,
        endDate: true,
        data: true,
        church: { select: { name: true } },
        certConfig: true,
      },
    });
    if (!event) throw new NotFoundException('Evento não encontrado');
    return event;
  }

  private async logoDoEvento(data: unknown) {
    const url = (data as Record<string, unknown> | null)?.logoUrl;
    if (typeof url !== 'string' || !url) return undefined;
    const imagens = await prepararImagens([{ url, formato: 'logo' }]);
    return imagens.get(`logo:${url}`);
  }

  private async dadosDoCertificado(
    event: Awaited<ReturnType<CertificadoService['evento']>>,
  ): Promise<EventoDoCertificado> {
    if (!event.certConfig?.enabled) {
      throw new BadRequestException(
        'O certificado deste evento não está ligado',
      );
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    return {
      nome: event.name,
      igreja: event.church?.name ?? '',
      periodo: periodoPorExtenso(event.startDate, event.endDate),
      cargaHoraria: event.certConfig.workload,
      logo: await this.logoDoEvento(event.data),
      colors: (data.colors ?? null) as EventoDoCertificado['colors'],
      assinaturas: (event.certConfig.signers ??
        []) as unknown as AssinaturaDoCertificado[],
      emitidoEm: hojePorExtenso(),
    };
  }

  /**
   * O código de cada inscrição, gerado na primeira vez que o certificado dela
   * sai. Dois códigos iguais são quase impossíveis (31⁸), mas o índice único
   * garante: na colisão, sorteia outro.
   */
  private async codigos(
    eventId: string,
    inscricoes: { userId: string; certificateCode: string | null }[],
  ): Promise<Map<string, string>> {
    const resultado = new Map<string, string>();
    for (const inscricao of inscricoes) {
      if (inscricao.certificateCode) {
        resultado.set(inscricao.userId, inscricao.certificateCode);
        continue;
      }
      for (let tentativa = 1; ; tentativa++) {
        const codigo = novoCodigo();
        try {
          await this.prisma.eventOnUsers.update({
            where: { userId_eventId: { userId: inscricao.userId, eventId } },
            data: { certificateCode: codigo },
          });
          resultado.set(inscricao.userId, codigo);
          break;
        } catch (erro) {
          const colisao =
            erro instanceof Prisma.PrismaClientKnownRequestError &&
            erro.code === 'P2002';
          if (!colisao || tentativa >= 5) throw erro;
        }
      }
    }
    return resultado;
  }

  /** Dos `userIds`, quem fez check-in, com o nome — só gente inscrita no evento */
  private async presentes(eventId: string, userIds: string[]) {
    return this.prisma.eventOnUsers.findMany({
      where: {
        eventId,
        userId: { in: userIds },
        user: { checkins: { some: { eventId, ...PRESENTE } } },
      },
      select: {
        userId: true,
        certificateCode: true,
        user: { select: { fullName: true } },
      },
      orderBy: { user: { fullName: 'asc' } },
    });
  }

  private async imprimir(html: string) {
    const page = await novaPagina();
    try {
      await page.setContent(
        await embutirFonte(html, URL_DA_FONTE_DO_CERTIFICADO),
        { waitUntil: 'load' },
      );
      await page.evaluate(() => document.fonts.ready);
      return await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
      });
    } finally {
      await page.close();
    }
  }

  private async gerarCertificados(
    evento: EventoDoCertificado,
    certificados: CertificadoDoPdf[],
  ): Promise<Buffer> {
    await prepararNavegador();
    const final = await PDFDocument.create();
    final.setTitle(`Certificados · ${evento.nome}`);

    for (let i = 0; i < certificados.length; i += POR_PARTE) {
      const parte = await this.imprimir(
        htmlDosCertificados(evento, certificados.slice(i, i + POR_PARTE)),
      );
      const doc = await PDFDocument.load(parte);
      const paginas = await final.copyPages(doc, doc.getPageIndices());
      paginas.forEach((pagina) => final.addPage(pagina));
    }

    return Buffer.from(await final.save());
  }

  /**
   * Os certificados dos marcados na lista do painel, um por página. Quem não
   * fez check-in fica de fora: a tela nem deixa marcar, mas é aqui que vale.
   */
  async pdfDosCertificados(eventId: string, userIds: string[]) {
    const event = await this.evento(eventId);
    const evento = await this.dadosDoCertificado(event);
    const presentes = await this.presentes(eventId, userIds);

    if (!presentes.length) {
      throw new BadRequestException(
        'Ninguém dos marcados fez check-in: não há certificado a gerar',
      );
    }

    const codigos = await this.codigos(eventId, presentes);
    const buffer = await this.gerarCertificados(
      evento,
      presentes.map((p) => ({
        nome: p.user.fullName,
        codigo: codigos.get(p.userId)!,
        urlDeVerificacao: urlDeVerificacao(codigos.get(p.userId)!),
      })),
    );

    return {
      buffer,
      fileName:
        presentes.length === 1
          ? `certificado-${slug(presentes[0].user.fullName)}.pdf`
          : `certificados-${slug(event.name)}.pdf`,
    };
  }

  /**
   * O certificado da própria pessoa: inscrita, presente, com o evento já
   * terminado e o certificado ligado. A recusa diz o que falta.
   */
  async pdfDoMeuCertificado(eventId: string, userId: string) {
    const event = await this.evento(eventId);
    if (!event.certConfig?.enabled) {
      throw new ForbiddenException('Este evento não emite certificado');
    }
    if (!eventoTerminou(event.endDate)) {
      throw new ForbiddenException(
        'O certificado fica disponível depois que o evento termina',
      );
    }

    const [presenca] = await this.presentes(eventId, [userId]);
    if (!presenca) {
      throw new ForbiddenException(
        'O certificado é de quem fez check-in no evento',
      );
    }

    const evento = await this.dadosDoCertificado(event);
    const codigos = await this.codigos(eventId, [presenca]);
    const codigo = codigos.get(userId)!;
    const buffer = await this.gerarCertificados(evento, [
      {
        nome: presenca.user.fullName,
        codigo,
        urlDeVerificacao: urlDeVerificacao(codigo),
      },
    ]);

    return { buffer, fileName: `certificado-${slug(event.name)}.pdf` };
  }

  /**
   * A lista de presença: todos os inscritos, com o nome do crachá, o tipo de
   * inscrição e o grupo (de cada inscrição, quando são mais de uma) e a hora
   * de chegada de quem fez check-in (nula para quem não veio).
   */
  async presenca(eventId: string) {
    const [inscricoes, checkins] = await Promise.all([
      this.prisma.eventOnUsers.findMany({
        where: { eventId },
        select: {
          userId: true,
          user: {
            select: { fullName: true, badgeName: true, profilePhotoUrl: true },
          },
          rolesRegistration: {
            select: {
              role: {
                select: {
                  description: true,
                  group: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { user: { fullName: 'asc' } },
      }),
      this.prisma.checkin.findMany({
        where: { eventId, ...PRESENTE },
        select: { userId: true, badgeDeliveredAt: true, updatedAt: true },
      }),
    ]);

    const chegou = new Map(
      checkins.map((c) => [c.userId, c.badgeDeliveredAt ?? c.updatedAt]),
    );

    return inscricoes.map((inscricao) => {
      const chegada = chegou.get(inscricao.userId);
      // quem está em mais de um grupo tem um tipo de inscrição em cada
      const inscricoesDoUsuario = [...inscricao.rolesRegistration].sort(
        (a, b) => a.role.group.name.localeCompare(b.role.group.name, 'pt-BR'),
      );
      return {
        userId: inscricao.userId,
        nome: inscricao.user.fullName,
        nomeNoCracha: inscricao.user.badgeName ?? null,
        foto: inscricao.user.profilePhotoUrl ?? null,
        tipo:
          inscricoesDoUsuario.map((r) => r.role.description).join(', ') ||
          'Sem inscrição',
        grupo:
          inscricoesDoUsuario.map((r) => r.role.group.name).join(', ') ||
          'Sem grupo',
        chegada: chegada ? horaDeChegada(chegada) : null,
      };
    });
  }

  /**
   * A verificação pública do código. Mostra o nome, o evento e a data — e só
   * isso: nada de CPF ou contato. O certificado deixa de valer se o check-in
   * for desfeito ou o certificado do evento for desligado.
   */
  async verificar(codigo: string) {
    const normalizado = codigo.trim().toUpperCase();
    const inscricao = await this.prisma.eventOnUsers.findUnique({
      where: { certificateCode: normalizado },
      select: {
        userId: true,
        eventId: true,
        user: { select: { fullName: true } },
        event: {
          select: {
            name: true,
            startDate: true,
            endDate: true,
            church: { select: { name: true } },
            certConfig: { select: { enabled: true, workload: true } },
          },
        },
      },
    });

    const presente =
      inscricao &&
      (await this.prisma.checkin.count({
        where: {
          userId: inscricao.userId,
          eventId: inscricao.eventId,
          ...PRESENTE,
        },
      }));

    if (!inscricao || !presente || !inscricao.event.certConfig?.enabled) {
      throw new NotFoundException('Certificado não encontrado');
    }

    return {
      codigo: normalizado,
      nome: inscricao.user.fullName,
      evento: inscricao.event.name,
      igreja: inscricao.event.church?.name ?? '',
      periodo: periodoPorExtenso(
        inscricao.event.startDate,
        inscricao.event.endDate,
      ),
      cargaHoraria: inscricao.event.certConfig.workload,
    };
  }
}
