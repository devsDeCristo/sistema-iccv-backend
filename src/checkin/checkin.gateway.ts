import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

  constructor(private readonly jwtService: JwtService) {}

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
      this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'default_secret',
      });
    } catch {
      this.logger.warn('Conexão de check-in recusada: token inválido');
      client.disconnect(true);
    }
  }

  @SubscribeMessage('checkin:join')
  join(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { eventId?: string } | string,
  ) {
    const eventId = typeof payload === 'string' ? payload : payload?.eventId;
    if (!eventId) return { joined: false };

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
