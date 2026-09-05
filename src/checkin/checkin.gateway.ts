import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma';
import { Role } from 'src/auth/roles';
import { SELECT_TENANT, isSuperAdmin, tenantChurchIds } from 'src/auth/tenant';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

/** Uma sala por evento: o check-in de um evento não interessa aos outros. */
const room = (eventId: string) => `checkin:${eventId}`;

/**
 * Canal de notificação do check-in.
 *
 * O socket transporta apenas o aviso de que a fila do evento mudou — nunca os
 * dados dos participantes. As telas reagem ao aviso refazendo as chamadas REST,
 * que continuam protegidas por JwtAuthGuard + RolesGuard. Assim um socket
 * comprometido não vaza nada, e a autorização vive num lugar só.
 */
@WebSocketGateway({
  namespace: '/checkin',
  cors: { origin: true, credentials: true },
})
export class CheckinGateway implements OnGatewayConnection {
  private readonly logger = new Logger(CheckinGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Só aceita conexões com um JWT válido. Sem isso, qualquer um na rede do
   * evento conseguiria abrir um socket e mapear a atividade da recepção.
   */
  handleConnection(client: Socket) {
    const token =
      client.handshake.auth?.token ||
      client.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'default_secret',
      });

      // guardado para o `join`: é por ele que se confere de quem é a sala.
      // O perfil não vem daqui — o token dura 24h e o vínculo pode ter mudado.
      client.data.userId = payload?.sub;
    } catch {
      this.logger.warn('Conexão de check-in recusada: token inválido');
      client.disconnect(true);
    }
  }

  /**
   * A sala é do evento, e o evento é de uma igreja: entrar nela é operar a
   * recepção daquele evento. Sem esta conferência, qualquer pessoa logada
   * abria o socket e acompanhava o movimento da recepção da igreja vizinha —
   * quem chegou e a que horas — mesmo sem conseguir ler as rotas REST.
   */
  @SubscribeMessage('checkin:join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string } | string,
  ) {
    const eventId = typeof payload === 'string' ? payload : payload?.eventId;
    if (!eventId) return { joined: false };

    const userId = client.data?.userId;
    if (!userId) return { joined: false };

    const [requester, event] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: SELECT_TENANT,
      }),
      this.prisma.event.findUnique({
        where: { id: eventId },
        select: { churchId: true },
      }),
    ]);

    if (!requester || !event) return { joined: false };

    // check-in é trabalho de admin: o financeiro e o inscrito não entram, e o
    // admin só entra na sala de evento de igreja que ele administra
    const igrejas = tenantChurchIds(requester, [Role.ADMIN]);

    if (igrejas === null) {
      // super admin e dev passam; qualquer outro sem vínculo não é gente de
      // painel
      if (!isSuperAdmin(requester)) return { joined: false };
    } else if (!igrejas.includes(event.churchId)) {
      return { joined: false };
    }

    client.join(room(eventId));
    return { joined: true, eventId };
  }

  @SubscribeMessage('checkin:leave')
  leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string } | string,
  ) {
    const eventId = typeof payload === 'string' ? payload : payload?.eventId;
    if (eventId) client.leave(room(eventId));
    return { left: true };
  }

  /**
   * Avisa as telas do evento que a fila mudou. `reason` serve só para a
   * interface decidir se mostra um alerta ("fulano entrou na fila").
   */
  notifyQueueChanged(eventId: string, reason: string, userId?: string) {
    // O gateway pode não ter subido ainda em cenários de teste/CLI.
    this.server?.to(room(eventId)).emit('checkin:updated', {
      eventId,
      reason,
      userId,
    });
  }
}
