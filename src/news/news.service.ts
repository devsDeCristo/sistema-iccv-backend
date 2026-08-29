import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventStatus, PrismaService } from '../prisma';
import {
  resolveImageExtension,
  uploadImageFirebase,
} from 'src/utils/uploadImgFirebase';
import { WhatsappService } from 'src/whatsapp/whatsapp.service';
import { NewsDto } from './dto/news.dto';

/**
 * Tamanho máximo da mensagem.
 *
 * Mensagem de texto o WhatsApp aceita longa, mas ninguém lê um textão no
 * celular. Legenda de imagem é outra história: o aplicativo corta perto de
 * 1024 caracteres, então quando a notícia tem foto o limite é bem menor.
 */
const LIMITE_DO_TEXTO = 3500;
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
  async findPublished(take?: number) {
    return this.prisma.news.findMany({
      where: { isPublished: true },
      select: CAMPOS_DO_FEED,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: take && take > 0 ? take : undefined,
    });
  }

  /** Lista do admin: inclui rascunho, ordenada pela última mexida. */
  async findAll() {
    return this.prisma.news.findMany({
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

    const noticia = await this.prisma.news.create({
      data: {
        title: data.title.trim(),
        summary: data.summary?.trim() || null,
        content: data.content,
        isPublished: data.isPublished,
        publishedAt: data.isPublished ? new Date() : null,
        authorId: authorId ?? null,
      },
    });

    await this.sincronizaDestinos(noticia.id, data.groupRoleIds);

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
    if (salva.isPublished) this.disparaEmSegundoPlano(salva.id);

    return salva;
  }

  async update(id: string, data: NewsDto) {
    const atual = await this.prisma.news.findUnique({ where: { id } });
    if (!atual) throw new NotFoundException('Notícia não encontrada');

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
        imageUrl,
        // a data de publicação é a da primeira vez: republicar depois de virar
        // rascunho não muda a ordem do feed
        publishedAt:
          data.isPublished && !atual.publishedAt
            ? new Date()
            : atual.publishedAt,
      },
    });

    await this.sincronizaDestinos(id, data.groupRoleIds);

    // Só a virada de rascunho para publicada dispara. Corrigir uma vírgula numa
    // notícia já publicada não pode mandar tudo de novo para os grupos.
    if (!atual.isPublished && atualizada.isPublished) {
      this.disparaEmSegundoPlano(id);
    }

    return atualizada;
  }

  async remove(id: string) {
    const atual = await this.prisma.news.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!atual) throw new NotFoundException('Notícia não encontrada');

    await this.prisma.news.delete({ where: { id } });
  }

  /**
   * Reenvio pedido a mão no painel: manda de novo para todos os grupos
   * marcados, mesmo os que já receberam, montando a mensagem com o texto e a
   * imagem que a notícia tem agora. É o que o admin espera de um botão de
   * reenviar — corrigiu a notícia, clicou, o grupo recebe a versão certa.
   */
  async resendToWhatsapp(id: string) {
    const noticia = await this.prisma.news.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!noticia) throw new NotFoundException('Notícia não encontrada');

    return this.disparaNoWhatsapp(id, true);
  }

  /**
   * Dispara sem segurar a resposta do painel: publicar uma notícia não pode
   * ficar esperando o WhatsApp, nem falhar por causa dele. O resultado de cada
   * destino fica gravado em `news_on_group_roles`, que é o que a tela mostra.
   */
  private disparaEmSegundoPlano(newsId: string) {
    this.disparaNoWhatsapp(newsId).catch((erro) =>
      this.logger.error(`Disparo da notícia ${newsId} falhou: ${erro.message}`),
    );
  }

  /**
   * Manda a notícia para cada grupo escolhido.
   *
   * O ritmo não é decidido aqui: quem espaça as mensagens é a fila do
   * `WhatsappService`, que vale para o canal inteiro. Este laço só percorre os
   * destinos e anota o que aconteceu em cada um — pode demorar minutos, e tudo
   * bem, porque roda em segundo plano.
   *
   * `force` só vem do reenvio manual. No disparo automático ele fica falso para
   * que republicar uma notícia não repita a mensagem em quem já recebeu.
   */
  private async disparaNoWhatsapp(newsId: string, force = false) {
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
      },
    });

    if (!noticia) return { enviados: 0, falhas: 0, semLink: 0 };

    const mensagem = this.montaMensagem(noticia, !!noticia.imageUrl);
    // Dois grupos de inscrição podem apontar para o mesmo grupo do WhatsApp; a
    // mensagem sai uma vez só.
    const jidsAtendidos = new Set<string>();

    let enviados = 0;
    let falhas = 0;
    let semLink = 0;

    for (const destino of noticia.groups) {
      if (!force && destino.sentAt) continue;

      const nome = `${destino.groupRole.event.name} / ${destino.groupRole.name}`;
      const link = destino.groupRole.link?.trim();

      if (!link) {
        semLink++;

        await this.marcaDestino(
          newsId,
          destino.groupRoleId,
          'O grupo não tem link de WhatsApp preenchido.',
        );

        continue;
      }

      try {
        const jid = await this.whatsapp.resolveGroupIdFromInvite(link);

        if (jidsAtendidos.has(jid)) {
          // outro grupo de inscrição já cobriu este mesmo grupo do WhatsApp
          await this.marcaDestino(newsId, destino.groupRoleId, null);
          enviados++;
          continue;
        }

        await this.whatsapp.sendToGroup(jid, mensagem, noticia.imageUrl);

        jidsAtendidos.add(jid);
        enviados++;

        await this.marcaDestino(newsId, destino.groupRoleId, null);
      } catch (erro) {
        falhas++;

        const motivo = String(erro.message ?? erro);

        await this.marcaDestino(newsId, destino.groupRoleId, motivo);
        this.logger.error(
          `Notícia ${newsId} não saiu para "${nome}": ${motivo}`,
        );
      }
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
      data: motivo
        ? { error: motivo.slice(0, 500) }
        : { sentAt: new Date(), error: null },
    });
  }

  /**
   * Grupos que podem receber disparo: os que têm link, de eventos no ar
   * (ativos ou em teste). Evento encerrado não aparece — não há por que avisar
   * quem já passou.
   */
  async findWhatsappGroups() {
    const grupos = await this.prisma.groupRoles.findMany({
      where: {
        NOT: { link: null },
        event: { status: { in: EVENTOS_QUE_RECEBEM } },
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
}
