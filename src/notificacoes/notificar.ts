import { Logger } from '@nestjs/common';
import {
  ChurchRequestStatus,
  ChurchStatus,
  EventStatus,
  NotificationType,
  PrismaClient,
} from '@prisma/client';
import { Role } from 'src/auth/roles';

type Prisma = Pick<
  PrismaClient,
  | 'notification'
  | 'notificationRecipient'
  | 'userChurchRole'
  | 'user'
  | 'church'
  | 'churchRequest'
  | 'news'
  | 'event'
>;

type Aviso = {
  type: NotificationType;
  sourceId: string;
  title: string;
  body: string;
  churchId: string | null;
};

const logger = new Logger('Notificacoes');

/**
 * Roda o disparo sem nunca lançar: o aviso é consequência do cadastro, da
 * solicitação, da notícia, e não pode derrubar nenhum deles.
 */
async function seguro(origem: string, disparo: () => Promise<void>) {
  try {
    await disparo();
  } catch (erro) {
    logger.error(`Notificação de ${origem} falhou: ${erro?.message}`);
  }
}

/**
 * Cria a notificação para quem deve recebê-la — os destinatários são os de
 * agora, menos quem fez a ação. A mesma origem notifica uma vez só
 * (`@@unique([type, sourceId])`): quem chega depois bate no índice, e isso
 * não é erro — dois disparos da mesma notícia podem correr juntos.
 */
async function notificar(
  prisma: Prisma,
  aviso: Aviso,
  userIds: string[],
  quemFez?: string | null,
) {
  const para = userIds.filter((id) => id !== quemFez);
  if (!para.length) return;
  try {
    await prisma.notification.create({
      data: {
        ...aviso,
        recipients: {
          createMany: { data: para.map((userId) => ({ userId })) },
        },
      },
    });
  } catch (erro) {
    if (erro?.code !== 'P2002') throw erro;
  }
}

/** Quem tem um destes vínculos na igreja (o pastor é admin dela) */
const vinculadosDa = async (
  prisma: Prisma,
  churchId: string,
  roles: Role[] = [Role.ADMIN],
) =>
  (
    await prisma.userChurchRole.findMany({
      where: { churchId, role: { in: roles } },
      select: { userId: true },
    })
  ).map((v) => v.userId);

/**
 * Os membros da igreja; com evento, quem está nele (inscrito ou na lista de
 * espera), de qualquer igreja — a regra do mural (`NewsService.filtroDoFeed`).
 */
const publicoDa = async (prisma: Prisma, churchId: string, eventId?: string) =>
  (
    await prisma.user.findMany({
      where: eventId
        ? {
            OR: [
              { events: { some: { eventId } } },
              { waitlists: { some: { eventId } } },
            ],
          }
        : { memberChurchId: churchId },
      select: { id: true },
    })
  ).map((m) => m.id);

/** Cadastro com pedido para ser membro: avisa os admins da igreja pedida */
export const notificarPedidoDeMembro = (
  prisma: Prisma,
  userId: string,
  churchId: string,
) =>
  seguro(`pedido de membro ${userId}`, async () => {
    const [pessoa, igreja] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      }),
      prisma.church.findUnique({
        where: { id: churchId },
        select: { name: true },
      }),
    ]);
    await notificar(
      prisma,
      {
        type: NotificationType.MEMBERSHIP_REQUEST,
        sourceId: userId,
        title: 'Novo pedido de membro',
        body: `${pessoa?.fullName} pediu para ser membro de ${igreja?.name}`,
        churchId,
      },
      await vinculadosDa(prisma, churchId),
      userId,
    );
  });

/**
 * O pedido saiu da fila (aceito, recusado, ou a pessoa entrou como membro por
 * outro caminho): o "Novo pedido" some do sininho dos admins, que levaria a
 * uma aba onde ele já não está.
 */
export const encerrarPedidoDeMembro = (prisma: Prisma, userId: string) =>
  seguro(`fim do pedido de ${userId}`, async () => {
    await prisma.notificationRecipient.deleteMany({
      where: {
        notification: {
          type: NotificationType.MEMBERSHIP_REQUEST,
          sourceId: userId,
        },
      },
    });
  });

/** O admin aceitou ou recusou o pedido: avisa a pessoa */
export const notificarRespostaDoPedido = (
  prisma: Prisma,
  userId: string,
  churchId: string,
  aceito: boolean,
  quemFez?: string,
) =>
  seguro(`resposta do pedido de ${userId}`, async () => {
    const igreja = await prisma.church.findUnique({
      where: { id: churchId },
      select: { name: true },
    });
    await notificar(
      prisma,
      {
        type: NotificationType.MEMBERSHIP_ANSWERED,
        sourceId: `${churchId}:${userId}`,
        title: aceito ? 'Pedido de membro aceito' : 'Pedido de membro recusado',
        body: aceito
          ? `Agora você é membro de ${igreja?.name}`
          : `${igreja?.name} recusou o seu pedido para ser membro`,
        churchId,
      },
      [userId],
      quemFez,
    );
  });

/**
 * Nova solicitação: avisa os admins e a tesouraria da igreja — os dois
 * entram no painel de Solicitações, e aprovar pede o pastor (admin) e a
 * tesouraria.
 */
export const notificarSolicitacao = (prisma: Prisma, requestId: string) =>
  seguro(`solicitação ${requestId}`, async () => {
    const s = await prisma.churchRequest.findUnique({
      where: { id: requestId },
      select: {
        title: true,
        churchId: true,
        requesterId: true,
        requester: { select: { fullName: true } },
      },
    });
    if (!s) return;
    await notificar(
      prisma,
      {
        type: NotificationType.CHURCH_REQUEST,
        sourceId: requestId,
        title: 'Nova solicitação',
        body: `${s.requester.fullName}: ${s.title}`,
        churchId: s.churchId,
      },
      await vinculadosDa(prisma, s.churchId, [Role.ADMIN, Role.TESOURARIA]),
      s.requesterId,
    );
  });

/**
 * Um dos dois aprovou e falta o outro: avisa quem falta — a tesouraria da
 * igreja (`AWAITING_TREASURY`) ou o pastor, o líder espiritual dela
 * (`AWAITING_PASTOR`). Uma vez por situação (`<id>:<status>`). Sem pastor
 * cadastrado não há a quem avisar: a tela da solicitação já diz isso.
 */
export const notificarVezNaSolicitacao = (
  prisma: Prisma,
  requestId: string,
  quemFez?: string,
) =>
  seguro(`vez na solicitação ${requestId}`, async () => {
    const s = await prisma.churchRequest.findUnique({
      where: { id: requestId },
      select: {
        title: true,
        status: true,
        churchId: true,
        church: { select: { spiritualLeaderId: true } },
      },
    });
    if (!s) return;
    const daTesouraria = s.status === ChurchRequestStatus.AWAITING_TREASURY;
    if (!daTesouraria && s.status !== ChurchRequestStatus.AWAITING_PASTOR) {
      return;
    }
    const pastor = s.church.spiritualLeaderId;
    await notificar(
      prisma,
      {
        type: NotificationType.CHURCH_REQUEST_AWAITING,
        sourceId: `${requestId}:${s.status}`,
        title: daTesouraria
          ? 'Solicitação aguardando a tesouraria'
          : 'Solicitação aguardando o pastor',
        body: `${daTesouraria ? 'O pastor' : 'A tesouraria'} aprovou: ${
          s.title
        }`,
        churchId: s.churchId,
      },
      daTesouraria
        ? await vinculadosDa(prisma, s.churchId, [Role.TESOURARIA])
        : pastor
        ? [pastor]
        : [],
      quemFez,
    );
  });

const TITULO_DA_RESPOSTA: Partial<Record<ChurchRequestStatus, string>> = {
  IN_REVIEW: 'Solicitação em análise',
  ACCEPTED: 'Solicitação aceita',
  PARTIALLY_ACCEPTED: 'Solicitação aceita em parte',
  REJECTED: 'Solicitação recusada',
};

/**
 * A situação da solicitação mudou: avisa quem pediu. Uma vez por situação
 * (`<id>:<status>`); voltar para "solicitada" não é notícia para ninguém.
 */
export const notificarRespostaDaSolicitacao = (
  prisma: Prisma,
  requestId: string,
  quemFez?: string,
) =>
  seguro(`resposta da solicitação ${requestId}`, async () => {
    const s = await prisma.churchRequest.findUnique({
      where: { id: requestId },
      select: {
        title: true,
        status: true,
        response: true,
        churchId: true,
        requesterId: true,
      },
    });
    const titulo = s && TITULO_DA_RESPOSTA[s.status];
    if (!s || !titulo) return;
    await notificar(
      prisma,
      {
        type: NotificationType.CHURCH_REQUEST_ANSWERED,
        sourceId: `${requestId}:${s.status}`,
        title: titulo,
        body: s.response ? `${s.title} — ${s.response}` : s.title,
        churchId: s.churchId,
      },
      [s.requesterId],
      quemFez,
    );
  });

/**
 * Notícia no ar: avisa os membros da igreja que publicou — e, se o público é
 * um evento, quem está nele (inscritos ou na lista de espera, de qualquer
 * igreja), a mesma regra do mural. O aviso do sistema (sem igreja) não tem
 * membros e não notifica ninguém.
 *
 * Uma vez por publicação (`<id>:<publishedAt>`): tirar do ar e voltar não
 * avisa de novo, mas cada disparo agendado é uma publicação nova — a notícia
 * volta ao topo do mural, e o sininho acompanha.
 */
export const notificarNoticia = (prisma: Prisma, newsId: string) =>
  seguro(`notícia ${newsId}`, async () => {
    const n = await prisma.news.findUnique({
      where: { id: newsId },
      select: {
        title: true,
        summary: true,
        publishedAt: true,
        churchId: true,
        eventId: true,
        authorId: true,
        church: { select: { name: true } },
      },
    });
    if (!n?.churchId || !n.publishedAt) return;
    await notificar(
      prisma,
      {
        type: NotificationType.NEWS,
        sourceId: `${newsId}:${n.publishedAt.getTime()}`,
        title: n.title,
        body: n.summary || n.church?.name || 'Nova notícia',
        churchId: n.churchId,
      },
      await publicoDa(prisma, n.churchId, n.eventId ?? undefined),
      n.authorId,
    );
  });

/**
 * Evento aberto ao público (ACTIVE; ensaio não conta): avisa os membros da
 * igreja. Uma vez por evento — desligar e religar não avisa de novo.
 *
 * Igreja em implantação esconde os eventos dela (`filtroDeEventoEmTeste`): o
 * aviso espera a igreja sair do teste (`notificarEventosDaIgreja`), em vez de
 * levar para uma página que não abre e gastar a única vez.
 */
export const notificarEvento = (
  prisma: Prisma,
  eventId: string,
  quemFez?: string,
) =>
  seguro(`evento ${eventId}`, async () => {
    const e = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        name: true,
        status: true,
        churchId: true,
        church: { select: { status: true } },
      },
    });
    if (e?.status !== EventStatus.ACTIVE) return;
    if (e.church.status === ChurchStatus.TEST) return;
    await notificar(
      prisma,
      {
        type: NotificationType.EVENT,
        sourceId: eventId,
        title: 'Novo evento',
        body: e.name,
        churchId: e.churchId,
      },
      await publicoDa(prisma, e.churchId),
      quemFez,
    );
  });

/**
 * A igreja saiu da implantação: os eventos dela que já estavam abertos (e não
 * acabaram) dão agora o aviso que esperaram.
 */
export const notificarEventosDaIgreja = (prisma: Prisma, churchId: string) =>
  seguro(`eventos da igreja ${churchId}`, async () => {
    const eventos = await prisma.event.findMany({
      where: {
        churchId,
        status: EventStatus.ACTIVE,
        endDate: { gte: new Date() },
      },
      select: { id: true },
    });
    for (const { id } of eventos) await notificarEvento(prisma, id);
  });
