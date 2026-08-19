import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CheckinStatus, PrismaService } from '../prisma';
import { CheckinGateway } from './checkin.gateway';

/** Etapas da fila, na ordem em que a recepção as executa. */
const QUEUE_STATUSES = [CheckinStatus.QUEUED, CheckinStatus.IN_PROGRESS];

/**
 * Quantos candidatos tentar ao chamar o próximo da fila. Com dois operadores
 * disputando a mesma pessoa, a primeira tentativa pode perder a corrida; a
 * segunda já pega outro. Cinco é folga de sobra para a escala de um evento.
 */
const NEXT_CANDIDATES = 5;

const hora = (data?: Date | null) =>
  data
    ? data.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      })
    : '';

@Injectable()
export class CheckinService {
  constructor(
    private prisma: PrismaService,
    private gateway: CheckinGateway,
  ) {}

  /**
   * Projeção usada nas duas telas. Quarto e equipe entram porque a recepção
   * informa isso ao entregar o crachá.
   */
  private readonly registrationSelect = {
    userId: true,
    eventId: true,
    user: {
      select: {
        id: true,
        fullName: true,
        badgeName: true,
        profilePhotoUrl: true,
        registrationNumber: true,
        cpf: true,
        cellphone: true,
        city: true,
        bedrooms: {
          select: {
            bedrooms: { select: { id: true, name: true, eventId: true } },
          },
        },
        TeamOnUsers: {
          select: {
            role: true,
            team: { select: { id: true, name: true, eventId: true } },
          },
        },
      },
    },
    rolesRegistration: {
      select: {
        role: {
          select: { description: true, group: { select: { name: true } } },
        },
      },
    },
  };

  /** Resolve os ids de operador gravados no check-in para nomes exibíveis. */
  private async operatorNames(checkins: { [key: string]: any }[]) {
    const ids = Array.from(
      new Set(
        checkins
          .flatMap((checkin) => [
            checkin?.badgeDeliveredById,
            checkin?.calledById,
            checkin?.doneById,
          ])
          .filter((id): id is string => !!id),
      ),
    );

    if (!ids.length) return new Map<string, string>();

    const operators = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });

    return new Map(operators.map((op) => [op.id, op.fullName]));
  }

  private mapParticipant(
    registration: any,
    checkin: any,
    operators: Map<string, string>,
  ) {
    const user = registration.user;
    const eventId = registration.eventId;
    const nome = (id?: string | null) => (id ? operators.get(id) || null : null);

    return {
      userId: user.id,
      fullName: user.fullName,
      badgeName: user.badgeName,
      profilePhotoUrl: user.profilePhotoUrl,
      registrationNumber: user.registrationNumber,
      cpf: user.cpf,
      cellphone: user.cellphone,
      city: user.city,
      roles: registration.rolesRegistration.map(
        (item: any) => item.role.description,
      ),
      groups: Array.from(
        new Set(
          registration.rolesRegistration
            .map((item: any) => item.role.group?.name)
            .filter(Boolean),
        ),
      ),
      // quarto e equipe só do evento em questão
      bedroom:
        user.bedrooms.find((item: any) => item.bedrooms.eventId === eventId)
          ?.bedrooms.name || null,
      teams: user.TeamOnUsers.filter(
        (item: any) => item.team.eventId === eventId,
      ).map((item: any) => ({ name: item.team.name, role: item.role })),
      status: checkin?.status || CheckinStatus.PENDING,
      badgeDeliveredAt: checkin?.badgeDeliveredAt || null,
      calledAt: checkin?.calledAt || null,
      doneAt: checkin?.doneAt || null,
      notes: checkin?.notes || null,
      badgeDeliveredBy: nome(checkin?.badgeDeliveredById),
      calledBy: nome(checkin?.calledById),
      doneBy: nome(checkin?.doneById),
    };
  }

  /** Garante que a pessoa realmente está inscrita antes de qualquer etapa. */
  private async findRegistration(eventId: string, userId: string) {
    const registration = await this.prisma.eventOnUsers.findUnique({
      where: { userId_eventId: { userId, eventId } },
      select: this.registrationSelect,
    });

    if (!registration) {
      throw new NotFoundException('Participante não inscrito neste evento');
    }

    return registration;
  }

  private async participantResponse(eventId: string, userId: string) {
    const [registration, checkin] = await Promise.all([
      this.findRegistration(eventId, userId),
      this.prisma.checkin.findUnique({
        where: { userId_eventId: { userId, eventId } },
      }),
    ]);

    const operators = await this.operatorNames([checkin].filter(Boolean));
    return this.mapParticipant(registration, checkin, operators);
  }

  /**
   * Lista da recepção: sem termo devolve todos os inscritos do evento, porque a
   * tela mostra a lista inteira e filtra no cliente. Com termo, filtra por
   * nome, CPF ou número de inscrição — sempre restrita aos inscritos do evento.
   */
  async search(eventId: string, query?: string) {
    const termo = (query || '').trim();
    const somenteDigitos = termo.replace(/\D/g, '');
    const numeroInscricao = /^\d+$/.test(termo) ? Number(termo) : undefined;

    const filtros: any[] = [];
    if (termo) {
      filtros.push({ fullName: { contains: termo, mode: 'insensitive' } });
      if (somenteDigitos) {
        filtros.push({ cpf: { contains: somenteDigitos } });
      }
      if (numeroInscricao !== undefined) {
        filtros.push({ registrationNumber: numeroInscricao });
      }
    }

    const registrations = await this.prisma.eventOnUsers.findMany({
      where: {
        eventId,
        ...(filtros.length ? { user: { OR: filtros } } : {}),
      },
      select: this.registrationSelect,
      orderBy: { user: { fullName: 'asc' } },
    });

    const checkins = await this.prisma.checkin.findMany({
      where: {
        eventId,
        userId: { in: registrations.map((item) => item.userId) },
      },
    });

    const porUsuario = new Map(checkins.map((item) => [item.userId, item]));
    const operators = await this.operatorNames(checkins);

    return registrations.map((registration) =>
      this.mapParticipant(
        registration,
        porUsuario.get(registration.userId),
        operators,
      ),
    );
  }

  /** Fila do posto de foto: quem já recebeu crachá e ainda não terminou. */
  async queue(eventId: string) {
    const checkins = await this.prisma.checkin.findMany({
      where: { eventId, status: { in: QUEUE_STATUSES } },
      // FIFO por chegada na recepção
      orderBy: { badgeDeliveredAt: 'asc' },
    });

    const registrations = await this.prisma.eventOnUsers.findMany({
      where: { eventId, userId: { in: checkins.map((item) => item.userId) } },
      select: this.registrationSelect,
    });

    const porUsuario = new Map(
      registrations.map((item) => [item.userId, item]),
    );
    const operators = await this.operatorNames(checkins);

    const participantes = checkins
      // a inscrição pode ter sido removida depois do check-in começar
      .filter((checkin) => porUsuario.has(checkin.userId))
      .map((checkin) =>
        this.mapParticipant(
          porUsuario.get(checkin.userId),
          checkin,
          operators,
        ),
      );

    return {
      waiting: participantes.filter(
        (item) => item.status === CheckinStatus.QUEUED,
      ),
      inProgress: participantes.filter(
        (item) => item.status === CheckinStatus.IN_PROGRESS,
      ),
    };
  }

  async stats(eventId: string) {
    const [totalInscritos, porStatus] = await Promise.all([
      this.prisma.eventOnUsers.count({ where: { eventId } }),
      this.prisma.checkin.groupBy({
        by: ['status'],
        where: { eventId },
        _count: { _all: true },
      }),
    ]);

    const contagem = (status: CheckinStatus) =>
      porStatus.find((item) => item.status === status)?._count._all || 0;

    const queued = contagem(CheckinStatus.QUEUED);
    const inProgress = contagem(CheckinStatus.IN_PROGRESS);
    const done = contagem(CheckinStatus.DONE);

    return {
      total: totalInscritos,
      queued,
      inProgress,
      done,
      // quem ainda não passou pela recepção; linha inexistente conta como pendente
      pending: Math.max(totalInscritos - queued - inProgress - done, 0),
    };
  }

  /**
   * Etapa 1 — recepção reconheceu o participante e entregou o crachá.
   * Ele entra na fila do posto de foto.
   */
  async deliverBadge(eventId: string, userId: string, operatorId: string) {
    await this.findRegistration(eventId, userId);

    const existente = await this.prisma.checkin.findUnique({
      where: { userId_eventId: { userId, eventId } },
    });

    if (!existente) {
      try {
        await this.prisma.checkin.create({
          data: {
            userId,
            eventId,
            status: CheckinStatus.QUEUED,
            badgeDeliveredAt: new Date(),
            badgeDeliveredById: operatorId,
          },
        });
      } catch (error: any) {
        // P2002: o outro operador criou a linha entre o findUnique e o create
        if (error?.code === 'P2002') {
          throw new ConflictException(
            'Outro operador acabou de entregar o crachá deste participante',
          );
        }
        throw error;
      }
    } else {
      const { count } = await this.prisma.checkin.updateMany({
        // o status no filtro é o que torna a operação segura entre operadores
        where: { userId, eventId, status: CheckinStatus.PENDING },
        data: {
          status: CheckinStatus.QUEUED,
          badgeDeliveredAt: new Date(),
          badgeDeliveredById: operatorId,
          calledAt: null,
          calledById: null,
          doneAt: null,
          doneById: null,
        },
      });

      if (count === 0) {
        const operators = await this.operatorNames([existente]);
        const quem = existente.badgeDeliveredById
          ? operators.get(existente.badgeDeliveredById)
          : null;

        throw new ConflictException(
          `Crachá já entregue${quem ? ` por ${quem}` : ''}${
            existente.badgeDeliveredAt
              ? ` às ${hora(existente.badgeDeliveredAt)}`
              : ''
          }`,
        );
      }
    }

    this.gateway.notifyQueueChanged(eventId, 'badge-delivered', userId);
    return this.participantResponse(eventId, userId);
  }

  /** Etapa 2 — o posto de foto chama alguém específico da fila. */
  async call(eventId: string, userId: string, operatorId: string) {
    const { count } = await this.prisma.checkin.updateMany({
      where: { userId, eventId, status: CheckinStatus.QUEUED },
      data: {
        status: CheckinStatus.IN_PROGRESS,
        calledAt: new Date(),
        calledById: operatorId,
      },
    });

    if (count === 0) {
      const atual = await this.prisma.checkin.findUnique({
        where: { userId_eventId: { userId, eventId } },
      });

      if (!atual || atual.status === CheckinStatus.PENDING) {
        throw new ConflictException(
          'Este participante ainda não retirou o crachá na recepção',
        );
      }

      const operators = await this.operatorNames([atual]);
      const quem = atual.calledById ? operators.get(atual.calledById) : null;

      throw new ConflictException(
        atual.status === CheckinStatus.DONE
          ? 'O check-in deste participante já foi concluído'
          : `Participante já chamado${quem ? ` por ${quem}` : ''}${
              atual.calledAt ? ` às ${hora(atual.calledAt)}` : ''
            }`,
      );
    }

    this.gateway.notifyQueueChanged(eventId, 'called', userId);
    return this.participantResponse(eventId, userId);
  }

  /**
   * Etapa 2 — chama o primeiro da fila. Se dois operadores clicarem junto,
   * cada um leva um participante diferente em vez de os dois pegarem o mesmo.
   */
  async callNext(eventId: string, operatorId: string) {
    const candidatos = await this.prisma.checkin.findMany({
      where: { eventId, status: CheckinStatus.QUEUED },
      orderBy: { badgeDeliveredAt: 'asc' },
      take: NEXT_CANDIDATES,
      select: { userId: true },
    });

    for (const candidato of candidatos) {
      const { count } = await this.prisma.checkin.updateMany({
        where: {
          userId: candidato.userId,
          eventId,
          status: CheckinStatus.QUEUED,
        },
        data: {
          status: CheckinStatus.IN_PROGRESS,
          calledAt: new Date(),
          calledById: operatorId,
        },
      });

      if (count === 1) {
        this.gateway.notifyQueueChanged(eventId, 'called', candidato.userId);
        return this.participantResponse(eventId, candidato.userId);
      }
    }

    throw new NotFoundException('Não há ninguém aguardando na fila');
  }

  /**
   * Etapa 3 — foto tirada e dados conferidos. Aceita quem está `IN_PROGRESS` e
   * também quem ainda está `QUEUED`, para o caso do operador atender sem clicar
   * em "chamar" antes.
   */
  async complete(
    eventId: string,
    userId: string,
    operatorId: string,
    notes?: string,
  ) {
    const { count } = await this.prisma.checkin.updateMany({
      where: { userId, eventId, status: { in: QUEUE_STATUSES } },
      data: {
        status: CheckinStatus.DONE,
        doneAt: new Date(),
        doneById: operatorId,
        ...(notes !== undefined ? { notes } : {}),
      },
    });

    if (count === 0) {
      const atual = await this.prisma.checkin.findUnique({
        where: { userId_eventId: { userId, eventId } },
      });

      if (!atual || atual.status === CheckinStatus.PENDING) {
        throw new ConflictException(
          'Este participante ainda não retirou o crachá na recepção',
        );
      }

      const operators = await this.operatorNames([atual]);
      const quem = atual.doneById ? operators.get(atual.doneById) : null;

      throw new ConflictException(
        `Check-in já concluído${quem ? ` por ${quem}` : ''}${
          atual.doneAt ? ` às ${hora(atual.doneAt)}` : ''
        }`,
      );
    }

    this.gateway.notifyQueueChanged(eventId, 'completed', userId);
    return this.participantResponse(eventId, userId);
  }

  /**
   * Desfaz uma etapa. Erro de operação acontece no balcão, e sem isso a única
   * saída seria mexer no banco durante o evento.
   */
  async undo(eventId: string, userId: string) {
    const atual = await this.prisma.checkin.findUnique({
      where: { userId_eventId: { userId, eventId } },
    });

    if (!atual || atual.status === CheckinStatus.PENDING) {
      throw new ConflictException('Não há etapa de check-in para desfazer');
    }

    const anterior = {
      [CheckinStatus.DONE]: {
        status: CheckinStatus.IN_PROGRESS,
        doneAt: null,
        doneById: null,
      },
      [CheckinStatus.IN_PROGRESS]: {
        status: CheckinStatus.QUEUED,
        calledAt: null,
        calledById: null,
      },
      [CheckinStatus.QUEUED]: {
        status: CheckinStatus.PENDING,
        badgeDeliveredAt: null,
        badgeDeliveredById: null,
      },
    }[atual.status];

    const { count } = await this.prisma.checkin.updateMany({
      // volta só se ninguém mudou o status enquanto isso
      where: { userId, eventId, status: atual.status },
      data: anterior,
    });

    if (count === 0) {
      throw new ConflictException(
        'O status deste participante mudou. Atualize a tela e tente de novo.',
      );
    }

    this.gateway.notifyQueueChanged(eventId, 'undone', userId);
    return this.participantResponse(eventId, userId);
  }
}
