import { Logger } from '@nestjs/common';
import {
  ChurchRequestStatus,
  EventStatus,
  NotificationType,
  PrismaClient,
} from '@prisma/client';
import { Role } from 'src/auth/roles';

type Prisma = Pick<
  PrismaClient,
  | 'notification'
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
 * (`@@unique([type, sourceId])`).
 */
async function notificar(
  prisma: Prisma,
  aviso: Aviso,
  userIds: string[],
  quemFez?: string | null,
) {
  const para = userIds.filter((id) => id !== quemFez);
  if (!para.length) return;
  const ja = await prisma.notification.findUnique({
    where: { type_sourceId: { type: aviso.type, sourceId: aviso.sourceId } },
    select: { id: true },
  });
  if (ja) return;
  await prisma.notification.create({
    data: {
      ...aviso,
      recipients: { createMany: { data: para.map((userId) => ({ userId })) } },
    },
  });
}

const adminsDa = async (prisma: Prisma, churchId: string) =>
  (
    await prisma.userChurchRole.findMany({
      where: { churchId, role: Role.ADMIN },
      select: { userId: true },
    })
  ).map((v) => v.userId);

const membrosDa = async (prisma: Prisma, churchId: string, eventId?: string) =>
  (
    await prisma.user.findMany({
      where: {
        memberChurchId: churchId,
        ...(eventId && {
          OR: [
            { events: { some: { eventId } } },
            { waitlists: { some: { eventId } } },
          ],
        }),
      },
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
      await adminsDa(prisma, churchId),
      userId,
    );
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

/** Nova solicitação: avisa os admins da igreja */
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
      await adminsDa(prisma, s.churchId),
      s.requesterId,
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
 * um evento, só os que estão nele (inscritos ou na lista de espera), a mesma
 * regra do mural. O aviso do sistema (sem igreja) não tem membros e não
 * notifica ninguém.
 */
export const notificarNoticia = (prisma: Prisma, newsId: string) =>
  seguro(`notícia ${newsId}`, async () => {
    const n = await prisma.news.findUnique({
      where: { id: newsId },
      select: {
        title: true,
        summary: true,
        churchId: true,
        eventId: true,
        authorId: true,
        church: { select: { name: true } },
      },
    });
    if (!n?.churchId) return;
    await notificar(
      prisma,
      {
        type: NotificationType.NEWS,
        sourceId: newsId,
        title: n.title,
        body: n.summary || n.church?.name || 'Nova notícia',
        churchId: n.churchId,
      },
      await membrosDa(prisma, n.churchId, n.eventId ?? undefined),
      n.authorId,
    );
  });

/**
 * Evento aberto ao público (ACTIVE; ensaio não conta): avisa os membros da
 * igreja. Uma vez por evento — desligar e religar não avisa de novo.
 */
export const notificarEvento = (
  prisma: Prisma,
  eventId: string,
  quemFez?: string,
) =>
  seguro(`evento ${eventId}`, async () => {
    const e = await prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, status: true, churchId: true },
    });
    if (e?.status !== EventStatus.ACTIVE) return;
    await notificar(
      prisma,
      {
        type: NotificationType.EVENT,
        sourceId: eventId,
        title: 'Novo evento',
        body: e.name,
        churchId: e.churchId,
      },
      await membrosDa(prisma, e.churchId),
      quemFez,
    );
  });
