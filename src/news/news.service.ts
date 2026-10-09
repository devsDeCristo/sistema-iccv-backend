import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { runAsJob } from 'src/context/request.context';
import { NewsDispatchOrigin, NewsScheduleKind } from '@prisma/client';
import { EventStatus, PrismaService } from '../prisma';
import {
  SELECT_TENANT,
  assertChurchAccess,
  churchIdsComPerfil,
  tenantChurchIds,
} from 'src/auth/tenant';
import { Role } from 'src/auth/roles';
import {
  resolveImageExtension,
  uploadImageFirebase,
} from 'src/utils/uploadImgFirebase';
import {
  extraiCodigoDoConvite,
  WhatsappService,
} from 'src/whatsapp/whatsapp.service';
import { NewsDto } from './dto/news.dto';
import { NewsScheduleDto } from './dto/news-schedule.dto';
import {
  MAXIMO_DE_AGENDAMENTOS,
  proximaExecucao,
  TOLERANCIA_DE_ATRASO_MS,
  validarAgendamento,
} from './agendamento';

/**
 * Tamanho máximo da mensagem.
 *
 * Mensagem de texto o WhatsApp aceita longa, mas ninguém lê um textão no
 * celular. Legenda de imagem é outra história: o aplicativo corta perto de
 * 1024 caracteres, então quando a notícia tem foto o limite é bem menor.
 */
const LIMITE_DO_TEXTO = 3500;

/** Links avulsos por notícia — mais que isso é engano */
const MAXIMO_DE_LINKS = 20;

/** `motivo` nulo marca como enviado; preenchido guarda a falha. */
const resultadoDoEnvio = (motivo: string | null) =>
  motivo
    ? { error: motivo.slice(0, 500) }
    : { sentAt: new Date(), error: null };

/**
 * Confere e padroniza os links avulsos. Cada um vira
 * `https://chat.whatsapp.com/CODIGO`: o mesmo grupo colado com e sem
 * `?mode=...` não vira dois destinos. `undefined` é "não mexi nos links".
 */
export function normalizaLinks(links?: string[]): string[] | undefined {
  if (!links) return undefined;

  const prontos = links.map((link) => {
    const codigo = extraiCodigoDoConvite(link);
    if (!codigo) {
      throw new BadRequestException(
        `"${link}" não é um link de grupo do WhatsApp (https://chat.whatsapp.com/...).`,
      );
    }
    return `https://chat.whatsapp.com/${codigo}`;
  });

  const unicos = [...new Set(prontos)];

  if (unicos.length > MAXIMO_DE_LINKS) {
    throw new BadRequestException(
      `Uma notícia pode ter no máximo ${MAXIMO_DE_LINKS} links de grupo.`,
    );
  }

  return unicos;
}

/**
 * No ar = publicada e com data de publicação. A notícia agendada é publicada,
 * mas fica sem data — fora do mural e sem disparo — até o primeiro horário,
 * quando o relógio a põe no ar.
 */
const NO_AR = { isPublished: true, publishedAt: { not: null } };
const noAr = (news: { isPublished: boolean; publishedAt: Date | null }) =>
  news.isPublished && !!news.publishedAt;

/** O calendário pede um mês por vez; folga para a grade de semanas cheias */
const PERIODO_MAXIMO_DO_CALENDARIO_MS = 62 * 24 * 60 * 60 * 1000;
const LIMITE_DA_LEGENDA = 950;

/** Só evento no ar recebe disparo: encerrado não tem por que ser avisado. */
const EVENTOS_QUE_RECEBEM = [EventStatus.ACTIVE, EventStatus.TEST];

/**
 * O corpo vem como HTML do editor. No WhatsApp isso vira texto, mas não texto
 * cru: negrito, itálico e lista têm equivalente no aplicativo e são traduzidos,
 * porque a notícia foi escrita com essa formatação e perdê-la empobrece o
 * aviso. O link vira "texto (endereço)" — só o texto deixaria o endereço para
 * trás.
 */
function htmlParaTexto(html: string): string {
  return (
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|h[1-6])\s*>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/li>/gi, '\n')
      // fecha a lista com linha em branco, senão o parágrafo seguinte cola no
      // último item
      .replace(/<\/\s*(ul|ol)\s*>/gi, '\n')
      .replace(/<\s*(strong|b)\s*>([\s\S]*?)<\/\s*(strong|b)\s*>/gi, '*$2*')
      .replace(/<\s*(em|i)\s*>([\s\S]*?)<\/\s*(em|i)\s*>/gi, '_$2_')
      .replace(
        /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_todo, endereco, texto) => {
          const rotulo = texto.replace(/<[^>]+>/g, '').trim();

          // rótulo igual ao endereço não precisa da repetição entre parênteses
          return !rotulo || rotulo === endereco
            ? endereco
            : `${rotulo} (${endereco})`;
        },
      )
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Campos que o feed do inscrito precisa — sem rascunho e sem dado interno. */
const CAMPOS_DO_FEED = {
  id: true,
  title: true,
  summary: true,
  content: true,
  imageUrl: true,
  publishedAt: true,
  createdAt: true,
  author: { select: { fullName: true } },
  // evento do anúncio restrito: o mural mostra de qual ele fala
  event: { select: { id: true, name: true } },
};

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  constructor(
    private prisma: PrismaService,
    private whatsapp: WhatsappService,
  ) {}

  /**
   * Feed do inscrito: só publicadas, da mais recente para a mais antiga.
   *
   * Ordena por `publishedAt` com `createdAt` como desempate — notícia publicada
   * e reeditada não pula para o topo por causa da edição.
   */
  async findPublished(take?: number, requesterId?: string) {
    return this.prisma.news.findMany({
      where: {
        ...NO_AR,
        ...this.filtroDoFeed(requesterId),
      },
      select: CAMPOS_DO_FEED,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: take && take > 0 ? take : undefined,
    });
  }

  /** Lista do admin: inclui rascunho, ordenada pela última mexida. */
  async findAll(requesterId?: string) {
    const requester = requesterId ? await this.getRequester(requesterId) : null;
    const churchIds = tenantChurchIds(requester, [Role.ADMIN]);

    return this.prisma.news.findMany({
      where: churchIds ? { churchId: { in: churchIds } } : {},
      select: {
        ...CAMPOS_DO_FEED,
        isPublished: true,
        updatedAt: true,
        // destinos do WhatsApp com o resultado de cada envio: é o que a lista
        // do painel usa para mostrar "enviado", "pendente" ou o motivo da falha
        groups: {
          select: {
            groupRoleId: true,
            sentAt: true,
            error: true,
            groupRole: {
              select: {
                name: true,
                event: { select: { name: true } },
              },
            },
          },
        },
        // grupos avulsos, colados como link, com o resultado de cada envio
        groupLinks: {
          select: { id: true, link: true, sentAt: true, error: true },
        },
        // agendamentos de disparo, com o próximo já calculado
        schedules: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: [{ updatedAt: 'desc' }],
    });
  }

  async create(data: NewsDto, authorId?: string) {
    // valida a imagem antes de gravar: subir arquivo de um registro que vai
    // falhar deixa lixo no bucket
    const extensao = data.imageFile
      ? resolveImageExtension(data.imageFile)
      : null;

    const autor = authorId ? await this.getRequester(authorId) : null;
    const eventId = await this.resolvePublico(autor, data.eventId);
    await this.assertDestinosDaIgreja(autor, data.groupRoleIds);
    const links = normalizaLinks(data.groupLinks);

    const igrejaDaNoticia = await this.igrejaDaPublicacao(autor, eventId);

    const noticia = await this.prisma.news.create({
      data: {
        title: data.title.trim(),
        summary: data.summary?.trim() || null,
        content: data.content,
        isPublished: data.isPublished,
        // agendada: publicada, mas sem data até o primeiro horário — fica fora
        // do mural e não dispara agora (ver `noAr`)
        publishedAt: data.isPublished && !data.scheduled ? new Date() : null,
        authorId: authorId ?? null,
        // quem publicou; o mural não filtra por isso. Quem administra mais de
        // uma igreja publica pela igreja do evento escolhido, e sem evento
        // escolhido pela primeira delas — o aviso é dela.
        churchId: igrejaDaNoticia,
        eventId,
      },
    });

    await this.sincronizaDestinos(noticia.id, data.groupRoleIds);
    await this.sincronizaLinks(noticia.id, links);

    let salva = noticia;

    if (data.imageFile) {
      const { url } = await uploadImageFirebase(
        data.imageFile,
        `news/${noticia.id}/cover.${extensao}`,
      );

      salva = await this.prisma.news.update({
        where: { id: noticia.id },
        data: { imageUrl: url },
      });
    }

    // Depois da imagem subir: a mensagem no WhatsApp sai com a foto junto.
    if (noAr(salva)) {
      this.disparaEmSegundoPlano(salva.id, NewsDispatchOrigin.PUBLISH);
    }

    return salva;
  }

  async update(id: string, data: NewsDto, requesterId?: string) {
    const atual = await this.prisma.news.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Notícia não encontrada');

    const requester = await this.assertNoticiaDaIgreja(atual, requesterId);
    // campo ausente é "não mexi no público"; vazio é "volta a valer para todos"
    const eventId =
      data.eventId === undefined
        ? atual.eventId
        : await this.resolvePublico(requester, data.eventId);
    await this.assertDestinosDaIgreja(requester, data.groupRoleIds);
    const links = normalizaLinks(data.groupLinks);

    const extensao = data.imageFile
      ? resolveImageExtension(data.imageFile)
      : null;

    const imageUrl = data.imageFile
      ? (
          await uploadImageFirebase(
            data.imageFile,
            `news/${id}/cover.${extensao}`,
          )
        ).url
      : data.removeImage
      ? null
      : atual.imageUrl;

    const atualizada = await this.prisma.news.update({
      where: { id },
      data: {
        title: data.title.trim(),
        summary: data.summary?.trim() || null,
        content: data.content,
        isPublished: data.isPublished,
        eventId,
        imageUrl,
        // a data de publicação é a da primeira vez: republicar depois de virar
        // rascunho não muda a ordem do feed. Agendada e nunca publicada fica
        // sem data, esperando o primeiro horário
        publishedAt:
          data.isPublished && !data.scheduled && !atual.publishedAt
            ? new Date()
            : atual.publishedAt,
      },
    });

    await this.sincronizaDestinos(id, data.groupRoleIds);
    await this.sincronizaLinks(id, links);

    // Só a entrada no ar dispara. Corrigir uma vírgula numa notícia já
    // publicada não pode mandar tudo de novo para os grupos.
    if (!noAr(atual) && noAr(atualizada)) {
      this.disparaEmSegundoPlano(id, NewsDispatchOrigin.PUBLISH);
    }

    return atualizada;
  }

  async remove(id: string, requesterId?: string) {
    const atual = await this.prisma.news.findUnique({
      where: { id },
      select: { id: true, churchId: true },
    });
    if (!atual) throw new NotFoundException('Notícia não encontrada');

    await this.assertNoticiaDaIgreja(atual, requesterId);

    await this.prisma.news.delete({ where: { id } });
  }

  /**
   * Reenvio pedido a mão no painel: manda de novo para todos os grupos
   * marcados, mesmo os que já receberam, montando a mensagem com o texto e a
   * imagem que a notícia tem agora. É o que o admin espera de um botão de
   * reenviar — corrigiu a notícia, clicou, o grupo recebe a versão certa.
   */
  async resendToWhatsapp(id: string, requesterId?: string) {
    const noticia = await this.prisma.news.findUnique({
      where: { id },
      select: { id: true, churchId: true },
    });
    if (!noticia) throw new NotFoundException('Notícia não encontrada');

    await this.assertNoticiaDaIgreja(noticia, requesterId);

    return this.disparaNoWhatsapp(id, NewsDispatchOrigin.MANUAL);
  }

  /**
   * Troca os agendamentos **pendentes** da notícia pelos que vieram do
   * formulário. Lista vazia cancela todos os pendentes.
   *
   * O "uma vez" que já passou (`nextRunAt` nulo) fica: é o histórico que a
   * tela mostra desabilitado, e não volta no corpo — validado de novo, seria
   * recusado por não ser data futura.
   */
  async saveSchedules(
    id: string,
    entradas: NewsScheduleDto[],
    requesterId?: string,
  ) {
    const noticia = await this.prisma.news.findUnique({
      where: { id },
      select: { id: true, churchId: true },
    });
    if (!noticia) throw new NotFoundException('Notícia não encontrada');

    await this.assertNoticiaDaIgreja(noticia, requesterId);

    if (entradas.length > MAXIMO_DE_AGENDAMENTOS) {
      throw new BadRequestException(
        `Uma notícia pode ter no máximo ${MAXIMO_DE_AGENDAMENTOS} agendamentos.`,
      );
    }

    const agora = new Date();
    const prontos = entradas.map((entrada) =>
      validarAgendamento(entrada, agora),
    );

    // Transação interativa, e não a forma em array: o middleware de auditoria
    // lê as linhas antes do `deleteMany`, e no array o Prisma enfileira as
    // operações na ordem em que o middleware as solta — o `createMany` passava
    // na frente e o `deleteMany` apagava o horário recém-gravado. Mesmo caso
    // do `password-reset.service.ts`.
    await this.prisma.$transaction(async (tx) => {
      await tx.newsSchedule.deleteMany({
        where: {
          newsId: id,
          NOT: { kind: NewsScheduleKind.ONCE, nextRunAt: null },
        },
      });
      await tx.newsSchedule.createMany({
        data: prontos.map((pronto) => ({ ...pronto, newsId: id })),
      });
    });

    return this.prisma.newsSchedule.findMany({
      where: { newsId: id },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Calendário de disparos da tela de notícias, no período pedido:
   *
   * - `feitos`: as rodadas de `NewsDispatch`, com origem e saldo;
   * - `agendados`: cada ocorrência futura dos agendamentos — "toda terça" vira
   *   uma entrada por terça do período.
   *
   * Recortado pelas igrejas que a pessoa administra, como a lista de notícias.
   */
  async calendar(from: Date, to: Date, requesterId?: string) {
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from
    ) {
      throw new BadRequestException('Período inválido.');
    }
    if (to.getTime() - from.getTime() > PERIODO_MAXIMO_DO_CALENDARIO_MS) {
      throw new BadRequestException('O período pode ter no máximo 62 dias.');
    }

    const requester = requesterId ? await this.getRequester(requesterId) : null;
    const churchIds = tenantChurchIds(requester, [Role.ADMIN]);
    const daIgreja = churchIds ? { churchId: { in: churchIds } } : {};
    const noticia = { select: { id: true, title: true } };

    const [feitos, agendamentos] = await Promise.all([
      this.prisma.newsDispatch.findMany({
        where: { at: { gte: from, lt: to }, news: daIgreja },
        include: { news: noticia },
        orderBy: { at: 'asc' },
      }),
      this.prisma.newsSchedule.findMany({
        where: { nextRunAt: { not: null, lt: to }, news: daIgreja },
        include: { news: noticia },
      }),
    ]);

    const agendados = agendamentos.flatMap((agendamento) => {
      const ocorrencias: Date[] = [];
      let quando = agendamento.nextRunAt;

      // ponytail: teto de ocorrências por agendamento; 62 dias de semanal com
      // os 7 dias marcados dá 62, bem abaixo
      while (quando && quando < to && ocorrencias.length < 100) {
        if (quando >= from) ocorrencias.push(quando);
        quando = proximaExecucao(agendamento, quando);
      }

      return ocorrencias.map((at) => ({
        scheduleId: agendamento.id,
        kind: agendamento.kind,
        at,
        news: agendamento.news,
      }));
    });

    agendados.sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      feitos: feitos.map(({ newsId: _id, ...feito }) => feito),
      agendados,
    };
  }

  /** O relógio dos agendamentos: a cada minuto, dispara o que venceu. */
  @Cron(CronExpression.EVERY_MINUTE)
  dispararAgendados() {
    return runAsJob('dispararNoticiasAgendadas', () =>
      this.dispararVencidos(new Date()),
    );
  }

  /**
   * Dispara os agendamentos vencidos e já marca o próximo de cada um.
   *
   * - **Sem disparo duplo:** o agendamento só dispara se esta rodada conseguir
   *   trocar o `nextRunAt` que leu. Uma rodada que atrasou e encontrou a
   *   próxima no meio do caminho não dispara de novo.
   * - **Atraso grande:** passou de `TOLERANCIA_DE_ATRASO_MS` (servidor fora do
   *   ar), pula este e segue para o próximo.
   * - **Rascunho:** é publicado na hora. O agendamento é o "publicar mais tarde".
   * - **Dois agendamentos da mesma notícia no mesmo minuto:** sai uma vez só.
   */
  async dispararVencidos(agora: Date) {
    const vencidos = await this.prisma.newsSchedule.findMany({
      where: { nextRunAt: { lte: agora } },
      include: {
        news: { select: { id: true, isPublished: true, publishedAt: true } },
      },
    });

    const disparadas = new Set<string>();

    for (const agendamento of vencidos) {
      const marcado = agendamento.nextRunAt as Date;
      const atrasado =
        agora.getTime() - marcado.getTime() > TOLERANCIA_DE_ATRASO_MS;

      const { count } = await this.prisma.newsSchedule.updateMany({
        where: { id: agendamento.id, nextRunAt: marcado },
        data: {
          nextRunAt: proximaExecucao(agendamento, agora),
          ...(atrasado ? {} : { lastRunAt: agora }),
        },
      });
      if (!count) continue;

      const { news } = agendamento;

      if (atrasado) {
        this.logger.warn(
          `Agendamento ${agendamento.id} da notícia ${news.id} perdeu o horário ` +
            `(${marcado.toISOString()}) e foi pulado.`,
        );
        continue;
      }

      // rascunho fica parado: o horário passa e segue para o próximo, sem
      // publicar nem enviar nada
      if (!news.isPublished) continue;

      if (disparadas.has(news.id)) continue;
      disparadas.add(news.id);

      // Cada disparo agendado é uma nova publicação: a data passa a ser a
      // deste disparo, e a notícia volta ao topo do mural. Vale também para a
      // agendada que ainda não estava no ar, que entra nele agora.
      await this.prisma.news.update({
        where: { id: news.id },
        data: { publishedAt: agora },
      });

      this.logger.log(`Disparo agendado da notícia ${news.id}`);
      this.disparaEmSegundoPlano(news.id, NewsDispatchOrigin.SCHEDULE);
    }
  }

  /**
   * Dispara sem segurar a resposta do painel: publicar uma notícia não pode
   * ficar esperando o WhatsApp, nem falhar por causa dele. O resultado de cada
   * destino fica gravado em `news_on_group_roles`, que é o que a tela mostra.
   */
  private disparaEmSegundoPlano(newsId: string, origem: NewsDispatchOrigin) {
    this.disparaNoWhatsapp(newsId, origem).catch((erro) =>
      this.logger.error(`Disparo da notícia ${newsId} falhou: ${erro.message}`),
    );
  }

  /**
   * Manda a notícia para cada grupo escolhido.
   *
   * A notícia sai pelo número **da igreja que a publicou**. Cada uma pareia o
   * seu (ver `WhatsappService`), e é `noticia.churchId` que diz por qual
   * telefone o inscrito vai receber o aviso.
   *
   * O ritmo não é decidido aqui: quem espaça as mensagens é a fila da sessão
   * daquela igreja. Este laço só percorre os destinos e anota o que aconteceu
   * em cada um — pode demorar minutos, e tudo bem, porque roda em segundo
   * plano.
   *
   * Reenvio manual e agendamento mandam para todos os destinos. A publicação
   * pula quem já recebeu, para que republicar uma notícia não repita a
   * mensagem.
   *
   * Cada rodada que tentou algum destino vira uma linha em `NewsDispatch`, o
   * histórico que o calendário da tela mostra.
   */
  private async disparaNoWhatsapp(newsId: string, origem: NewsDispatchOrigin) {
    const force = origem !== NewsDispatchOrigin.PUBLISH;
    const inicio = new Date();

    const noticia = await this.prisma.news.findUnique({
      where: { id: newsId },
      include: {
        groups: {
          include: {
            groupRole: {
              select: {
                id: true,
                name: true,
                link: true,
                event: { select: { name: true } },
              },
            },
          },
        },
        groupLinks: true,
      },
    });

    if (!noticia) return { enviados: 0, falhas: 0, semLink: 0 };

    // Sem igreja não há número por onde sair. Acontece no histórico anterior ao
    // tenant; falhar calado aqui deixaria a notícia marcada como enviada.
    if (!noticia.churchId) {
      this.logger.warn(
        `Notícia ${newsId} não tem igreja: não há número de WhatsApp por onde disparar.`,
      );
      return { enviados: 0, falhas: 0, semLink: 0 };
    }

    const churchId = noticia.churchId;

    const mensagem = this.montaMensagem(noticia, !!noticia.imageUrl);
    // Dois grupos de inscrição podem apontar para o mesmo grupo do WhatsApp; a
    // mensagem sai uma vez só.
    const jidsAtendidos = new Set<string>();

    let enviados = 0;
    let falhas = 0;
    let semLink = 0;

    // Os dois tipos de destino — grupo de inscrição e link avulso — viram a
    // mesma coisa: um nome para o log, o link e onde anotar o resultado.
    const destinos = [
      ...noticia.groups.map((destino) => ({
        sentAt: destino.sentAt,
        nome: `${destino.groupRole.event.name} / ${destino.groupRole.name}`,
        link: destino.groupRole.link?.trim(),
        marca: (motivo: string | null) =>
          this.marcaDestino(newsId, destino.groupRoleId, motivo),
      })),
      ...noticia.groupLinks.map((destino) => ({
        sentAt: destino.sentAt,
        nome: destino.link,
        link: destino.link,
        marca: (motivo: string | null) =>
          this.prisma.newsGroupLink.update({
            where: { id: destino.id },
            data: resultadoDoEnvio(motivo),
          }),
      })),
    ];

    for (const destino of destinos) {
      if (!force && destino.sentAt) continue;

      const { nome, link } = destino;

      if (!link) {
        semLink++;

        await destino.marca('O grupo não tem link de WhatsApp preenchido.');

        continue;
      }

      try {
        const jid = await this.whatsapp.resolveGroupIdFromInvite(
          churchId,
          link,
        );

        if (jidsAtendidos.has(jid)) {
          // outro destino já cobriu este mesmo grupo do WhatsApp
          await destino.marca(null);
          enviados++;
          continue;
        }

        await this.whatsapp.sendToGroup(
          churchId,
          jid,
          mensagem,
          noticia.imageUrl,
        );

        jidsAtendidos.add(jid);
        enviados++;

        await destino.marca(null);
      } catch (erro) {
        falhas++;

        const motivo = String(erro.message ?? erro);

        await destino.marca(motivo);
        this.logger.error(
          `Notícia ${newsId} não saiu para "${nome}": ${motivo}`,
        );
      }
    }

    if (enviados + falhas + semLink > 0) {
      await this.prisma.newsDispatch.create({
        data: {
          newsId,
          origin: origem,
          at: inicio,
          sent: enviados,
          failed: falhas,
          noLink: semLink,
        },
      });
    }

    return { enviados, falhas, semLink };
  }

  /** `motivo` nulo marca como enviado; preenchido guarda a falha. */
  private async marcaDestino(
    newsId: string,
    groupRoleId: string,
    motivo: string | null,
  ) {
    await this.prisma.newsOnGroupRoles.update({
      where: { newsId_groupRoleId: { newsId, groupRoleId } },
      data: resultadoDoEnvio(motivo),
    });
  }

  /**
   * Grupos que podem receber disparo: os que têm link, de eventos no ar
   * (ativos ou em teste). Evento encerrado não aparece — não há por que avisar
   * quem já passou.
   */
  async findWhatsappGroups(requesterId?: string) {
    const requester = requesterId ? await this.getRequester(requesterId) : null;
    const churchIds = tenantChurchIds(requester, [Role.ADMIN]);

    const grupos = await this.prisma.groupRoles.findMany({
      where: {
        NOT: { link: null },
        event: {
          status: { in: EVENTOS_QUE_RECEBEM },
          ...(churchIds ? { churchId: { in: churchIds } } : {}),
        },
      },
      select: {
        id: true,
        name: true,
        link: true,
        event: { select: { id: true, name: true, status: true } },
      },
      orderBy: [{ event: { startDate: 'desc' } }, { name: 'asc' }],
    });

    // link em branco passa pelo `NOT: null` do banco e não serve para nada
    return grupos
      .filter((grupo) => grupo.link?.trim())
      .map(({ link, ...grupo }) => ({
        ...grupo,
        // o link em si não interessa para a tela; basta saber que existe
        temLink: !!link,
      }));
  }

  /**
   * Monta a mensagem: título na primeira linha, chamada na segunda, uma linha
   * em branco e o corpo da notícia.
   *
   * ```
   * *Inscrições abertas*
   * As vagas vão até 30 de agosto.
   *
   * Texto completo da notícia…
   * ```
   */
  private montaMensagem(
    noticia: { title: string; summary: string | null; content: string },
    comImagem: boolean,
  ) {
    // O asterisco é o negrito do WhatsApp.
    const linhas = [`*${noticia.title.trim()}*`];

    const chamada = noticia.summary?.trim();
    if (chamada) linhas.push(chamada);

    const corpo = htmlParaTexto(noticia.content);
    // corpo idêntico à chamada não merece ser repetido logo abaixo dela
    if (corpo && corpo !== chamada) linhas.push('', corpo);

    const mensagem = linhas.join('\n');
    const limite = comImagem ? LIMITE_DA_LEGENDA : LIMITE_DO_TEXTO;

    return mensagem.length > limite
      ? `${mensagem.slice(0, limite).trimEnd()}…`
      : mensagem;
  }

  /**
   * Quem vê o anúncio no mural.
   *
   * O padrão é todo mundo — inclusive quem ainda não se inscreveu em nada, e
   * sem olhar a igreja que publicou. O recorte só existe quando o admin
   * escolheu um evento: aí a notícia fica para quem está nele, inscrito ou na
   * lista de espera.
   */
  private filtroDoFeed(requesterId?: string) {
    if (!requesterId) return { eventId: null };

    return {
      OR: [
        { eventId: null },
        { event: { users: { some: { userId: requesterId } } } },
        { event: { waitlist: { some: { userId: requesterId } } } },
      ],
    };
  }

  /**
   * Igreja que assina a notícia — quem vai poder editá-la e reenviá-la depois.
   *
   * Com um vínculo só não há dúvida. Com mais de um, a igreja do evento
   * escolhido resolve; sem evento, fica com a primeira igreja da pessoa, que é
   * a única resposta possível sem inventar uma pergunta a mais no formulário.
   * Do super admin sai nula: aviso do sistema, sem dono.
   */
  private async igrejaDaPublicacao(
    autor: { role?: number | null; churchRoles?: any[] | null } | null,
    eventId: string | null,
  ): Promise<string | null> {
    const minhas = churchIdsComPerfil(autor, [Role.ADMIN]);
    if (!minhas.length) return null;

    if (eventId) {
      const evento = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { churchId: true },
      });

      if (evento && minhas.includes(evento.churchId)) return evento.churchId;
    }

    return minhas[0];
  }

  private async getRequester(requesterId: string) {
    return this.prisma.user.findUnique({
      where: { id: requesterId },
      select: SELECT_TENANT,
    });
  }

  /** Notícia de outra igreja não se edita, nem se apaga, nem se reenvia. */
  private async assertNoticiaDaIgreja(
    noticia: { churchId: string | null },
    requesterId?: string,
  ) {
    if (!requesterId) return null;

    const requester = await this.getRequester(requesterId);

    assertChurchAccess(requester, noticia.churchId, {
      roles: [Role.ADMIN],
      message: 'Esta notícia é de uma igreja que você não administra',
    });

    return requester;
  }

  /**
   * Público do anúncio: `null` (o padrão) é para todo mundo, um evento
   * restringe o mural a quem está nele.
   *
   * O evento tem que ser da igreja de quem publica — do contrário um admin
   * escreveria no mural do evento da igreja vizinha.
   */
  private async resolvePublico(
    requester: { role?: number | null; churchId?: string | null } | null,
    eventId?: string | null,
  ) {
    if (!eventId) return null;

    const evento = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { churchId: true },
    });

    if (!evento) {
      throw new NotFoundException('Evento não encontrado');
    }

    assertChurchAccess(requester, evento.churchId, {
      roles: [Role.ADMIN],
      message: 'Você não administra a igreja deste evento',
    });

    return eventId;
  }

  /**
   * Os grupos de WhatsApp vêm do formulário como ids: sem conferir a igreja de
   * cada um, um admin marcaria o grupo de um evento da igreja vizinha e a
   * mensagem sairia lá.
   */
  private async assertDestinosDaIgreja(
    requester: { role?: number | null; churchId?: string | null } | null,
    groupRoleIds?: string[],
  ) {
    const churchIds = tenantChurchIds(requester, [Role.ADMIN]);
    if (!churchIds || !groupRoleIds?.length) return;

    const permitidos = await this.prisma.groupRoles.count({
      where: {
        id: { in: groupRoleIds },
        event: { churchId: { in: churchIds } },
      },
    });

    if (permitidos !== new Set(groupRoleIds).size) {
      throw new BadRequestException(
        'Há grupos de eventos de outra igreja na lista de destinos',
      );
    }
  }

  /**
   * Acerta a lista de eventos que recebem a notícia.
   *
   * Destino que continua na lista não é recriado — se fosse, perderia o
   * registro de que a mensagem já saiu e o reenvio mandaria tudo de novo.
   */
  private async sincronizaDestinos(newsId: string, groupRoleIds?: string[]) {
    if (!groupRoleIds) return;

    if (groupRoleIds.length === 0) {
      await this.prisma.newsOnGroupRoles.deleteMany({ where: { newsId } });
      return;
    }

    const atuais = await this.prisma.newsOnGroupRoles.findMany({
      where: { newsId },
      select: { groupRoleId: true },
    });

    await this.prisma.newsOnGroupRoles.deleteMany({
      where: { newsId, groupRoleId: { notIn: groupRoleIds } },
    });

    const jaEstao = new Set(atuais.map((d) => d.groupRoleId));

    for (const groupRoleId of groupRoleIds) {
      if (!jaEstao.has(groupRoleId)) {
        await this.prisma.newsOnGroupRoles.create({
          data: { newsId, groupRoleId },
        });
      }
    }
  }

  /**
   * Acerta os links avulsos. Como em `sincronizaDestinos`, o que continua na
   * lista não é recriado: perderia o registro de que a mensagem já saiu.
   */
  private async sincronizaLinks(newsId: string, links?: string[]) {
    if (!links) return;

    await this.prisma.newsGroupLink.deleteMany({
      where: { newsId, link: { notIn: links } },
    });

    if (links.length) {
      await this.prisma.newsGroupLink.createMany({
        data: links.map((link) => ({ newsId, link })),
        skipDuplicates: true,
      });
    }
  }
}
