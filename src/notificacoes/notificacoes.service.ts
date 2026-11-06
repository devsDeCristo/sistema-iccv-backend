import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

const LIMITE = 30;

/**
 * O sininho de quem está logado. As notificações nascem em `notificar.ts`;
 * aqui só se lê e se marca como lida — sempre as da própria pessoa.
 */
@Injectable()
export class NotificacoesService {
  constructor(private readonly prisma: PrismaService) {}

  /** O sininho pergunta só isto a cada minuto; a lista vem ao abrir */
  async contarNaoLidas(userId: string) {
    const naoLidas = await this.prisma.notificationRecipient.count({
      where: { userId, readAt: null },
    });
    return { naoLidas };
  }

  async listar(userId: string) {
    const recebidas = await this.prisma.notificationRecipient.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: LIMITE,
      select: {
        readAt: true,
        notification: {
          select: {
            id: true,
            type: true,
            sourceId: true,
            title: true,
            body: true,
            churchId: true,
            createdAt: true,
          },
        },
      },
    });

    return recebidas.map(({ readAt, notification: n }) => ({
      id: n.id,
      tipo: n.type,
      // o evento abre pela página dele: a tela precisa do id
      origemId: n.sourceId,
      titulo: n.title,
      texto: n.body,
      churchId: n.churchId,
      data: n.createdAt,
      lida: !!readAt,
    }));
  }

  /** Sem `ids`, marca todas — inclusive as que não couberam na lista */
  async marcarLidas(userId: string, ids?: string[]) {
    await this.prisma.notificationRecipient.updateMany({
      where: {
        userId,
        readAt: null,
        ...(ids && { notificationId: { in: ids } }),
      },
      data: { readAt: new Date() },
    });
  }
}
