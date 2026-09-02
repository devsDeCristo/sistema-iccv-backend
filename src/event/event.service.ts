import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as sharp from 'sharp';

import {
  Event,
  EventStatus,
  PaymentMethod,
  PaymentReceived,
  PaymentStatus,
  Prisma,
  PrismaService,
} from '../prisma';
import { EventDto } from './dto/event.dto';
import { isAdminRole } from 'src/auth/roles';
import { MailService } from 'src/mail/mail.service';
import * as path from 'path';
import {
  resolveImageExtension,
  uploadImageFirebase,
} from 'src/utils/uploadImgFirebase';

type EventWithGroupRole = Prisma.EventGetPayload<{
  include: {
    groupRoles: {
      include: {
        roles: {
          include: {
            _count: { select: { EventOnUsers: true; Waitlist: true } };
          };
        };
      };
    };
  };
}>;

/** Dados mínimos usados para montar o e-mail de confirmação */
type EmailUser = { id: string; fullName: string; email: string };
type EmailEvent = {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  data: Prisma.JsonValue;
};

/** Escapa texto antes de interpolar em HTML (e-mails) */
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Hosts autorizados para download de imagens do evento (anti-SSRF) */
const DEFAULT_IMAGE_HOSTS = [
  'firebasestorage.googleapis.com',
  'storage.googleapis.com',
  'lh3.googleusercontent.com',
];

const IMAGE_FETCH_TIMEOUT_MS = 8000;
const IMAGE_FETCH_MAX_BYTES = 8 * 1024 * 1024;
/**
 * TTL longo de propósito: a chave do cache carrega o `updateAt` do evento
 * (ver `imageCacheKey`), então uma troca de logo/capa gera chave nova e
 * invalida sozinha — inclusive nas outras réplicas, que não veem o `update`.
 */
const IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Falha transitória (timeout, DNS, conexão derrubada) não pode virar entrada
 * de 24h, mas também não pode ficar sem cache: cada request repetiria um fetch
 * que custa ~1,5s. Meio termo curto.
 */
const IMAGE_CACHE_ERROR_TTL_MS = 30 * 1000;
const IMAGE_CACHE_MAX_ENTRIES = 50;

@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  /** Cache em memória (url -> dataURI) para evitar rebaixar a mesma imagem a cada request */
  private readonly imageCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();

  constructor(
    private prisma: PrismaService,
    private emailService: MailService,
  ) {}

  async registerUserInEvent(
    userId: string,
    eventId: string,
    registrationRoleIds: string[],
    options?: {
      tx?: Prisma.TransactionClient;
      attempt?: number;
      movingFromWaitlist?: boolean;
      /** quem disparou a inscrição pela API; ausente em chamadas internas */
      requesterId?: string;
    },
  ) {
    const MAX_RETRIES = 5;
    const tx = options?.tx;
    const attempt = options?.attempt ?? 1;

    if (!userId || !eventId) {
      throw new BadRequestException('Usuário e evento devem ser informados');
    }

    const uniqueRoleIds = Array.from(new Set(registrationRoleIds ?? []));

    if (!uniqueRoleIds.length) {
      throw new BadRequestException('Nenhuma regra de inscrição foi informada');
    }

    if (uniqueRoleIds.length !== (registrationRoleIds ?? []).length) {
      // mesma resposta de antes: ids repetidos nunca casam com o findMany de roles
      throw new BadRequestException('Role(s) inválido(s)');
    }

    // evento em teste não recebe inscrição de quem não enxerga o evento: sem
    // isso bastaria ter o id em mãos para entrar num evento ainda em ensaio
    if (options?.requesterId) {
      await this.assertEventIsVisible(eventId, options.requesterId);
    }

    try {
      const result = tx
        ? await this._registerUserInEventTx(
            tx,
            userId,
            eventId,
            registrationRoleIds,
          )
        : await this.prisma.$transaction(
            async (trx) =>
              this._registerUserInEventTx(
                trx,
                userId,
                eventId,
                registrationRoleIds,
              ),
            { isolationLevel: 'Serializable', maxWait: 10000, timeout: 30000 },
          );

      if (
        options?.movingFromWaitlist === true &&
        result.results.every((r) => r.type === 'WAITLIST')
      ) {
        return result.results;
      }
      // fire-and-forget: falha de e-mail não deve derrubar o processo
      this.sendEmailConfirmation({
        user: result.user,
        event: result.event,
        tickets: result.results,
      }).catch((error) =>
        this.logger.error(
          `Falha ao enviar e-mail de confirmação (user=${userId}, event=${eventId})`,
          error instanceof Error ? error.stack : String(error),
        ),
      );

      return result.results;
    } catch (error: any) {
      //  retry apenas para conflito de serialização
      // Prisma reporta conflito serializable como P2034 (write conflict/deadlock);
      // '40001' é o SQLSTATE cru, mantido para o caso de erro não encapsulado.
      const isSerializationConflict =
        error?.code === '40001' || error?.code === 'P2034';

      // Se a transaction é do chamador, ela já foi abortada: retry aqui não resolve.
      if (isSerializationConflict && !tx && attempt <= MAX_RETRIES) {
        return this.registerUserInEvent(userId, eventId, registrationRoleIds, {
          ...options,
          attempt: attempt + 1,
        });
      }
      throw error;
    }
  }

  private async _registerUserInEventTx(
    tx: PrismaService | Prisma.TransactionClient,
    userId: string,
    eventId: string,
    registrationRoleIds: string[],
  ) {
    //-------------------------- verificações iniciais --------------------------//
    // 1️⃣ Verifica usuário e evento (em paralelo)
    // seleciona apenas o necessário: evita carregar hash de senha do usuário
    const [user, event] = await Promise.all([
      tx.user.findUnique({
        where: { id: userId },
        select: { id: true, fullName: true, email: true },
      }),
      tx.event.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          name: true,
          startDate: true,
          endDate: true,
          data: true,
        },
      }),
    ]);

    if (!user) throw new NotFoundException('Usuario não encontrado');
    if (!event) throw new NotFoundException('Evento não encontrado');

    // 2️⃣ Busca roles solicitadas (já com grupo)
    const roles = await tx.rolesRegistration.findMany({
      where: {
        id: { in: registrationRoleIds },
        group: { eventId },
      },
      include: { group: true },
    });

    if (roles.length !== registrationRoleIds.length) {
      throw new BadRequestException('Role(s) inválido(s)');
    }

    // 3️⃣ Regra: roles devem ser de grupos diferentes
    const groupIds = roles.map((r) => r.groupId);
    if (new Set(groupIds).size !== groupIds.length) {
      throw new BadRequestException(
        'As regras devem pertencer a grupos diferentes',
      );
    }

    // 4️⃣ Busca inscrições e waitlist existentes em UMA query lógica
    const [existingRegistrations, existingWaitlist] = await Promise.all([
      tx.eventOnUsersRolesRegistration.findMany({
        where: { userId, eventId },
        select: {
          roleRegistrationId: true,
          role: { select: { groupId: true } },
        },
      }),
      tx.waitlist.findMany({
        where: {
          userId,
          eventId,
          roleRegistrationId: { in: registrationRoleIds },
        },
        select: { roleRegistrationId: true },
      }),
    ]);

    // 5️⃣ Regra: não pode repetir role
    const existingRoleIds = new Set(
      existingRegistrations.map((r) => r.roleRegistrationId),
    );

    if (registrationRoleIds.some((id) => existingRoleIds.has(id))) {
      throw new BadRequestException(
        'Usuário já registrado em grupos no evento',
      );
    }

    // 6️⃣ Regra: não pode ter dois roles do mesmo grupo no mesmo evento
    const existingGroupIds = new Set(
      existingRegistrations.map((r) => r.role.groupId),
    );

    if (roles.some((r) => existingGroupIds.has(r.groupId))) {
      throw new BadRequestException(
        'Usuário já registrado em uma regra do mesmo grupo neste evento',
      );
    }

    // 7️⃣ Regra: não pode estar na waitlist
    if (existingWaitlist.length > 0) {
      throw new BadRequestException(
        'Usuário já está na lista de espera para algumas regras de grupo no evento',
      );
    }

    //-------------------------- realiza inscrição --------------------------//

    const results: {
      roleId: string;
      type: 'WAITLIST' | 'REGISTERED';
      data: unknown;
    }[] = [];

    // contagem de vagas de todos os grupos antes do loop
    // (regra 3 garante 1 role por grupo, então a contagem não muda a cada iteração)
    const counts = await Promise.all(
      groupIds.map((groupId) =>
        tx.eventOnUsersRolesRegistration.count({
          where: { eventId, role: { groupId } },
        }),
      ),
    );

    const countByGroupId = new Map(
      groupIds.map((groupId, index) => [groupId, counts[index]]),
    );

    //Processa role por role */;
    for (const role of roles) {
      //verifica capacidade do grupo */
      const count = countByGroupId.get(role.groupId) ?? 0;

      if (role.group.capacity !== null && count >= role.group.capacity) {
        // caso esteja cheio, coloca na waitlist

        const waitlist = await tx.waitlist.create({
          data: {
            userId,
            eventId,
            roleRegistrationId: role.id,
          },
        });

        results.push({ roleId: role.id, type: 'WAITLIST', data: waitlist });
        continue;
      }
      //verifica se ja esta registrado no grupo

      //caso tenha vaga, registra no evento e cria um role de inscrição */

      await tx.eventOnUsers.upsert({
        where: { userId_eventId: { userId, eventId } },
        update: {},
        create: { userId, eventId },
      });

      const registration = await tx.eventOnUsersRolesRegistration.create({
        data: {
          userId,
          eventId,
          roleRegistrationId: role.id,
          payment: {
            create: {
              amount: role.price,
              status:
                role.price > 0 ? PaymentStatus.WAITING : PaymentStatus.PAID,
              method: role.price > 0 ? PaymentMethod.OTHER : PaymentMethod.CASH,
              receivedFrom: PaymentReceived.SYSTEM,
            },
          },
        },
      });

      results.push({ roleId: role.id, type: 'REGISTERED', data: registration });
    }

    return { user, event, results };
  }

  private async renderTickets(tickets: any[] = []): Promise<string> {
    if (!tickets.length) return '';

    const roleIds = tickets.map((t) => t.roleId).filter(Boolean);

    const rolesRegistrations = await this.prisma.rolesRegistration.findMany({
      where: { id: { in: roleIds } },
      select: {
        id: true,
        description: true,
        group: { select: { name: true } },
        // todas as inscrições da role pertencem ao mesmo evento,
        // então basta 1 registro para obter os dados do evento
        EventOnUsers: {
          take: 1,
          select: {
            eventOnUsers: { select: { event: { select: { data: true } } } },
          },
        },
      },
    });

    const statusMap: Record<string, string> = {
      REGISTERED: 'INSCRITO',
      WAITLIST: 'LISTA DE ESPERA',
    };

    const statusColors: Record<string, string> = {
      REGISTERED: '#16a34a',
      WAITLIST: '#ca8a04',
    };

    const items = tickets
      .map((ticket) => {
        const role = rolesRegistrations.find((r) => r.id === ticket.roleId);

        const roleName = escapeHtml(role?.description ?? 'N/A');
        const groupName = escapeHtml(role?.group?.name ?? 'N/A');
        const local = escapeHtml(
          role?.EventOnUsers[0]?.eventOnUsers?.event?.data?.['localName'] ?? '',
        );
        const statusLabel = escapeHtml(statusMap[ticket.type] ?? ticket.type);

        return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 8px; border: 1px solid #eceff5; border-radius: 8px">
          <tr>
            <td style="padding: 14px 16px; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size: 14px; line-height: 20px; color: #1a1a1a">
                    <strong>${groupName}</strong><br />
                    <span style="font-size: 13px; color: #6b7280">${roleName}</span>
                  </td>
                  <td align="right" style="font-size: 13px; line-height: 20px">
                    <span style="font-weight: 700; color: ${
                      statusColors[ticket.type] ?? '#1c0f4d'
                    }">${statusLabel}</span>
                    ${
                      local
                        ? `<br /><span style="color: #6b7280">${local}</span>`
                        : ''
                    }
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
      })
      .join('');

    return `<div style="margin: 0 0 20px">${items}</div>`;
  }

  /**
   * Faixa do evento, logo abaixo do cabeçalho da marca: a logo do evento sobre
   * a capa, como o app mostra o evento na tela. Capa e logo são opcionais em
   * `event.data`, então cada combinação tem seu próprio bloco — <img src="">
   * vira ícone de imagem quebrada no cliente de e-mail.
   */
  private renderEventBanner(data: any): string {
    const rawCover = this.safeImageUrl(data?.coverUrl);
    const cover = escapeHtml(rawCover);
    const logo = escapeHtml(this.safeImageUrl(data?.logoUrl));

    if (!cover && !logo) return '';

    // a capa também entra dentro de url('') no style: aspas e parênteses
    // fechariam a função CSS, então vão em percent-encode
    const coverCss = escapeHtml(
      rawCover.replace(
        /['"()\\]/g,
        (char) =>
          ({
            "'": '%27',
            '"': '%22',
            '(': '%28',
            ')': '%29',
            '\\': '%5C',
          }[char] ?? char),
      ),
    );

    const logoImg = logo
      ? `<img src="${logo}" alt="" height="72" style="display: block; height: 72px; max-height: 72px; width: auto; max-width: 80%; margin: 0 auto; border: 0" />`
      : '';

    // sem logo a capa entra como imagem de verdade: `background` em <td> é
    // ignorado pelo Outlook desktop, e aí sobraria só a faixa índigo.
    const content =
      cover && !logo
        ? `<img src="${cover}" alt="" width="600" style="display: block; width: 100%; max-width: 600px; height: auto; border: 0" />`
        : logoImg;

    const cellStyle = cover
      ? `background-color: #1c0f4d; background-image: url('${coverCss}'); background-size: cover; background-position: center; ${
          logo ? 'padding: 28px 24px' : 'font-size: 0; line-height: 0'
        }`
      : 'background-color: #1c0f4d; padding: 28px 24px; border-top: 1px solid #2c1a6b';

    return `
            <tr>
              <td align="center" bgcolor="#1C0F4D"${
                cover ? ` background="${cover}"` : ''
              } style="${cellStyle}">
                ${content}
              </td>
            </tr>`;
  }

  private async sendEmailConfirmation({
    user,
    event,
    tickets = [],
  }: {
    user: EmailUser;
    event: EmailEvent;
    tickets?: any[];
  }) {
    const data = (event.data ?? {}) as any;

    const LOCAL = [
      data?.localName,
      [data?.city, data?.state].filter(Boolean).join(', '),
      data?.neighborhood,
      data?.address,
    ]
      .filter(Boolean)
      .join(' - ')
      .concat(data?.zipCode ? ` - CEP: ${data.zipCode}` : '')
      .concat(data?.number ? ` - ${data.number}` : '');

    // valores vão direto para dentro do HTML do template -> precisam ser escapados
    const emailData = {
      eventTitle: escapeHtml(event.name),
      eventDescription: escapeHtml(data?.description ?? ''),
      userName: escapeHtml(user.fullName),
      eventDate: `${new Date(
        event.startDate,
      ).toLocaleDateString()} a ${new Date(
        event.endDate,
      ).toLocaleDateString()}`,
      INSERT_TICKETS: await this.renderTickets(tickets),
      EVENT_BANNER: this.renderEventBanner(data),
      LOCAL: escapeHtml(LOCAL),
    };

    const html = this.emailService.loadTemplate(
      'registration-confirmation',
      emailData,
    );

    await this.emailService.sendMail({
      to: user.email,
      subject: `Confirmação de inscrição no evento ${event.name}`,
      html,
      attachments: [
        {
          filename: 'logo.png',
          // versão branca: o cabeçalho é a faixa índigo da marca, e o
          // `logo.png` original é preto — sumiria dentro dela.
          path: path.join(
            process.cwd(),
            'src',
            'mail',
            'templates',
            'assets',
            'logo-branca.png',
          ),
          cid: 'logo',
        },
      ],
    });
  }

  async removeRelation(idUser: string, idEvent: string) {
    const relationExists = await this.prisma.eventOnUsers.findFirst({
      where: { userId: idUser, eventId: idEvent },
    });
    if (!relationExists) {
      throw new NotFoundException('Relation does not exists!');
    }
    await this.prisma.eventOnUsers
      .delete({
        where: { userId_eventId: { userId: idUser, eventId: idEvent } },
      })
      .catch((err) => {
        this.logger.error(
          `Falha ao remover relação usuário/evento (user=${idUser}, event=${idEvent})`,
          err instanceof Error ? err.stack : String(err),
        );
        throw new InternalServerErrorException();
      });
  }

  async updateUserFromEvent(
    userId: string,
    eventId: string,
    registrationRoleId: string[],
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        const relation = await tx.eventOnUsers.findUnique({
          where: { userId_eventId: { userId, eventId } },
        });

        if (!relation) {
          throw new NotFoundException('Usuario não está registrado no evento');
        }

        await tx.eventOnUsers.deleteMany({
          where: { userId, eventId },
        });

        const registration = await this.registerUserInEvent(
          userId,
          eventId,
          registrationRoleId,
          { tx },
        );
        if (registration.some((r: any) => r.type === 'WAITLIST')) {
          // se ainda ficou na waitlist, deve falar o tx
          throw new BadRequestException(
            'Não há vagas disponíveis no evento para o grupo selecionado',
          );
        }

        return registration;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  private handlerReturnAllEvents(events: any[]) {
    function transformData(events: Event[]) {
      return events.map((event: any) => {
        const data = {
          ...event,
          bedroom: event._count.bedrooms,
          team: event._count.Team,
          waitlist: event._count.waitlist,
          users: event._count.users,
          capacity: event.groupRoles.reduce(
            (acc: number, group: any) => acc + (group.capacity || 0),
            0,
          ),
        };
        delete data._count;
        delete data.groupRoles;
        return data;
      });
    }
    return transformData(events);
  }

  private handleformatUsers(data: any[]) {
    return data.map((item) => {
      /** 🔹 Agrupa roles por grupo */
      const groupsMap = new Map<string, any>();

      for (const rr of item.rolesRegistration) {
        const role = rr.role;
        const group = role.group;

        if (!groupsMap.has(group.id)) {
          groupsMap.set(group.id, {
            id: group.id,
            name: group.name,
            roles: [],
          });
        }

        groupsMap.get(group.id).roles.push({
          id: role.id,
          description: role.description,
          price: role.price,
        });
      }

      /** 🔹 Quartos */
      const bedrooms = item.user.bedrooms.map((b) => ({
        id: b.bedrooms.id,
        name: b.bedrooms.name,
        capacity: b.bedrooms.capacity,
      }));

      /** 🔹 Times */
      const teams = item.user.TeamOnUsers.map((t) => ({
        id: t.team.id,
        name: t.team.name,
        capacity: t.team.capacity,
      }));

      /** 🔹 Nunca expor o hash da senha na listagem de inscritos */
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { password, ...user } = item.user;

      return {
        ...user,
        /** 🔹 Data/hora da inscrição no evento (não confundir com createdAt da conta) */
        registeredAt: item.createdAt,
        groupsRegistration: Array.from(groupsMap.values()),
        bedrooms,
        teams,
      };
    });
  }
  private handleformatUsersWaitlist(data: any[]) {
    const positionsByGroup = new Map<string, number>();

    return data.map((item) => {
      const rr = item.rolesRegistration;
      const role = {
        id: rr?.id,
        description: rr?.description,
        price: rr?.price,
      };
      const group = rr?.group;
      const groupId = group?.id ?? 'without-group';
      const position = (positionsByGroup.get(groupId) ?? 0) + 1;

      positionsByGroup.set(groupId, position);

      return {
        ...item.user,
        waitlistId: item.id,
        waitlistCreatedAt: item.createdAt,
        waitlistPosition: position,
        roleRegistrationId: item.roleRegistrationId,
        groupsRegistration: [
          {
            id: group?.id,
            name: group?.name,
            roles: [role],
          },
        ],
      };
    });
  }
  /** Hosts liberados para download de imagem (override via IMAGE_FETCH_ALLOWED_HOSTS) */
  private get allowedImageHosts(): string[] {
    const fromEnv = (process.env.IMAGE_FETCH_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);

    return fromEnv.length ? fromEnv : DEFAULT_IMAGE_HOSTS;
  }

  /**
   * Só devolve a URL se for http(s) — impede que valores gravados em `event.data`
   * (ex.: `javascript:...`) virem atributo de link/imagem no e-mail.
   */
  private safeImageUrl(url: unknown): string {
    if (typeof url !== 'string' || !url) return '';

    try {
      const parsed = new URL(url);

      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
        ? url
        : '';
    } catch {
      return '';
    }
  }

  /**
   * Valida a URL antes do fetch: apenas https e hosts conhecidos do storage.
   * `event.data` é JSON livre gravado via API, então um valor arbitrário aqui
   * transformaria o servidor em proxy para a rede interna (SSRF).
   */
  private isFetchableImageUrl(url: string): boolean {
    try {
      const parsed = new URL(url);

      if (parsed.protocol !== 'https:') return false;

      const hostname = parsed.hostname.toLowerCase();

      return this.allowedImageHosts.some(
        (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
      );
    } catch {
      return false;
    }
  }

  /**
   * A URL do Storage é estável (o upload sempre grava no mesmo path), então ela
   * sozinha não distingue a logo nova da antiga. O `updateAt` do evento entra na
   * chave para que qualquer edição invalide a imagem em todas as réplicas — o
   * cache é de processo, e só a réplica que atendeu o PUT saberia apagá-lo.
   */
  private imageCacheKey(url: string, version?: string): string {
    return version ? `${url}#${version}` : url;
  }

  private getCachedImage(key: string): string | null | undefined {
    const cached = this.imageCache.get(key);

    if (!cached) return undefined;

    if (cached.expiresAt <= Date.now()) {
      this.imageCache.delete(key);
      return undefined;
    }

    return cached.value;
  }

  private setCachedImage(
    key: string,
    value: string | null,
    ttlMs: number = IMAGE_CACHE_TTL_MS,
  ) {
    if (this.imageCache.size >= IMAGE_CACHE_MAX_ENTRIES) {
      const oldestKey = this.imageCache.keys().next().value;
      if (oldestKey) this.imageCache.delete(oldestKey);
    }

    this.imageCache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Baixa a imagem e devolve como data URI. Custa ~1,5s por imagem em cache
   * frio: o endpoint `?alt=media` do Firebase Storage tem TTFB de ~1,1s mesmo
   * para arquivos de poucos KB. Por isso só é chamado sob demanda — ver
   * `findOne`.
   *
   * @param version identificador da versão da imagem para a chave do cache.
   */
  private async getLogoImgFromUrl(
    logoUrl?: string,
    version?: string,
  ): Promise<string | null> {
    if (!logoUrl) return null;

    const cacheKey = this.imageCacheKey(logoUrl, version);

    const cached = this.getCachedImage(cacheKey);
    if (cached !== undefined) return cached;

    if (!this.isFetchableImageUrl(logoUrl)) {
      this.logger.warn(`URL de imagem bloqueada: ${logoUrl}`);
      this.setCachedImage(cacheKey, null);
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      IMAGE_FETCH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(logoUrl, { signal: controller.signal });

      if (!response.ok) {
        this.setCachedImage(cacheKey, null);
        return null;
      }

      // um redirect não pode levar o download para fora dos hosts autorizados
      if (response.url && !this.isFetchableImageUrl(response.url)) {
        this.logger.warn(`Redirect de imagem bloqueado: ${response.url}`);
        this.setCachedImage(cacheKey, null);
        return null;
      }

      const contentType = response.headers.get('content-type') ?? 'image/png';

      if (!contentType.toLowerCase().startsWith('image/')) {
        this.setCachedImage(cacheKey, null);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      if (buffer.byteLength > IMAGE_FETCH_MAX_BYTES) {
        this.logger.warn(
          `Imagem acima do limite (${buffer.byteLength} bytes): ${logoUrl}`,
        );
        this.setCachedImage(cacheKey, null);
        return null;
      }

      const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`;
      this.setCachedImage(cacheKey, dataUri);

      return dataUri;
    } catch (error) {
      // sem cachear aqui, todo erro de rede vira um fetch novo (e lento) por
      // request; TTL curto porque a causa costuma ser transitória
      this.logger.warn(
        `Falha ao baixar imagem ${logoUrl}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      this.setCachedImage(cacheKey, null, IMAGE_CACHE_ERROR_TTL_MS);

      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Logo e capa como data URI, baixadas em paralelo. Ver `handlerReturnEvent`. */
  private async buildEmbeddedImages(
    event: EventWithGroupRole,
    eventData: Record<string, any>,
  ) {
    const logoUrl =
      typeof eventData.logoUrl === 'string' ? eventData.logoUrl : undefined;
    const coverUrl =
      typeof eventData.coverUrl === 'string' ? eventData.coverUrl : undefined;

    // versão da imagem no cache: muda a cada edição do evento
    const version = event.updateAt?.getTime().toString();

    const [logoBase64, coverBase64] = await Promise.all([
      this.getLogoImgFromUrl(logoUrl, version),
      this.getLogoImgFromUrl(coverUrl, version),
    ]);

    return { logoBase64, coverBase64 };
  }

  /**
   * @param embedImages baixa logo e capa e devolve em `data.logoBase64` /
   * `data.coverBase64`. Só o gerador de PDF precisa disso (o `@react-pdf` não
   * busca imagem remota), e cada imagem custa ~1,5s em cache frio — então o
   * padrão é não embutir e as chaves nem aparecem na resposta. A UI usa
   * `data.logoUrl` / `data.coverUrl`, que o navegador carrega e cacheia sozinho.
   */
  private async handlerReturnEvent(
    event: EventWithGroupRole,
    embedImages = false,
  ) {
    const eventData = (event.data ?? {}) as Record<string, any>;

    const base64Data = embedImages
      ? await this.buildEmbeddedImages(event, eventData)
      : {};

    return {
      ...event,
      data: {
        ...eventData,
        ...base64Data,
      },
      groupRoles: event.groupRoles.map((group) => ({
        ...group,
        roles: group.roles.map((role) => {
          const { _count, ...rest } = role;

          return {
            ...rest,
            registered: _count?.EventOnUsers ?? 0,
            waitlisted: _count?.Waitlist ?? 0,
          };
        }),
      })),
    };
  }

  // private async saveLogosFirebase(
  //   eventId: string,
  //   logoFile: Express.Multer.File,
  //   coverFile: Express.Multer.File,
  // ): Promise<{ coverUrl: string | null; logoUrl: string | null }> {
  //   const bucket = admin.storage().bucket();
  //   let logoUrl = null;
  //   let coverUrl = null;

  //   if (logoFile) {
  //     const logoPath = `events/${eventId}/logo/logo.svg`;
  //     const bucketName = admin.storage().bucket().name;

  //     const logoBucket = bucket.file(logoPath);
  //     await logoBucket.save(logoFile.buffer, {
  //       contentType: logoFile.mimetype,
  //     });

  //     const logoPublicPath = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
  //       logoPath,
  //     )}?alt=media`;
  //     logoUrl = logoPublicPath;
  //   }
  //   if (coverFile) {
  //     const coverPath = `events/${eventId}/cover/cover.${
  //       coverFile.mimetype.split('/')[1]
  //     }`;
  //     const bucketName = admin.storage().bucket().name;
  //     const coverBucket = bucket.file(coverPath);
  //     await coverBucket.save(coverFile.buffer, {
  //       contentType: coverFile.mimetype,
  //     });

  //     const coverPublicPath = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
  //       coverPath,
  //     )}?alt=media`;
  //     coverUrl = coverPublicPath;
  //   }
  //   return { coverUrl, logoUrl };
  // }

  /** Link do grupo é opcional: string vazia vira null no banco */
  private normalizeGroupLink(link?: string | null) {
    return link?.trim() || null;
  }

  /**
   * Garante que não exista outro evento com o mesmo nome (ignorando
   * maiúsculas/minúsculas e espaços nas pontas).
   */
  private async ensureEventNameIsAvailable(
    name: string,
    options: { ignoreEventId?: string; tx?: Prisma.TransactionClient } = {},
  ) {
    const client = options.tx ?? this.prisma;

    const existing = await client.event.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        ...(options.ignoreEventId
          ? { id: { not: options.ignoreEventId } }
          : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Já existe um evento com esse nome!');
    }
  }

  async create(data: EventDto) {
    // valida os arquivos antes de criar qualquer registro
    const coverExtension = data.coverFile
      ? resolveImageExtension(data.coverFile)
      : null;
    const logoExtension = data.logoFile
      ? resolveImageExtension(data.logoFile)
      : null;

    const name = data.name?.trim();

    if (!name) {
      throw new BadRequestException('O nome do evento é obrigatório');
    }

    try {
      data.endDate = new Date(data.endDate);
      data.startDate = new Date(data.startDate);

      // 1. Cria o evento primeiro (sem upload).
      // A verificação de nome duplicado roda dentro da transaction em modo
      // Serializable para que dois cliques seguidos não criem eventos repetidos.
      const event = await this.prisma.$transaction(
        async (tx) => {
          await this.ensureEventNameIsAvailable(name, { tx });

          return tx.event.create({
            data: {
              type: data.type,
              endDate: data.endDate,
              startDate: data.startDate,
              name,
              data: data.data as Prisma.JsonObject,
              groupRoles: {
                create: data.groupRoles?.map((gr) => ({
                  name: gr.name,
                  capacity: gr.capacity,
                  link: this.normalizeGroupLink(gr.link),
                  roles: {
                    create: gr.roles.map((r) => ({
                      price: r.price,
                      description: r.description,
                    })),
                  },
                })),
              },
              groupLink: data.groupLink,
              status: data.status ?? EventStatus.ACTIVE,
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );

      // 2. Uploads fora da transaction

      const [coverResult, logoResult] = await Promise.all([
        data.coverFile
          ? uploadImageFirebase(
              data.coverFile,
              `events/${event.id}/cover/cover.${coverExtension}`,
            )
          : null,

        data.logoFile
          ? uploadImageFirebase(
              data.logoFile,
              `events/${event.id}/logo/logo.${logoExtension}`,
            )
          : null,
      ]);

      const coverUrl = coverResult?.url ?? null;
      const logoUrl = logoResult?.url ?? null;

      const jsonData: Prisma.JsonObject = {
        ...((data.data as Prisma.JsonObject) ?? {}),
        coverUrl,
        logoUrl,
      };

      // 3. Atualiza o evento com URLs
      const updatedEvent = await this.prisma.event.update({
        where: { id: event.id },
        data: {
          data: jsonData,
        },
      });

      return updatedEvent;
    } catch (error) {
      // erros de negócio (ex.: nome duplicado) devem chegar ao front como estão
      if (error instanceof HttpException) {
        throw error;
      }

      // duas criações simultâneas com o mesmo nome: o Postgres aborta uma delas
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ConflictException(
          'Outro evento com esse nome está sendo criado neste momento. Tente novamente.',
        );
      }

      this.logger.error(
        'Falha ao criar evento',
        error instanceof Error ? error.stack : String(error),
      );
      throw new InternalServerErrorException();
    }
  }

  async findInsightsEvents() {
    const events = await this.prisma.event.findMany({
      select: {
        id: true,
        status: true,
        startDate: true,
        users: {
          select: {
            createdAt: true,
            user: {
              select: {
                worker: true,
              },
            },
          },
        },
      },
    });

    if (!events.length) {
      return {
        totalEvents: 0,
        totalEventsActive: 0,
        timeToFillHours: 0,
        timeToFillWorkerHours: 0,
        eventsInCurrentQuarter: 0,
      };
    }

    // 📊 Eventos por trimestre
    const trimestres = [0, 0, 0, 0];

    events.forEach((event) => {
      const month = new Date(event.startDate).getMonth();
      const quarter = Math.floor(month / 3);
      trimestres[quarter]++;
    });

    const totalEventos = trimestres.reduce((acc, val) => acc + val, 0);
    const eventsInCurrentQuarter = Number((totalEventos / 4).toFixed(2));

    // 📌 Totais
    const totalEvents = events.length;
    const totalEventsActive = events.filter(
      (e) => e.status === EventStatus.ACTIVE,
    ).length;

    // ⏱ Calcula tempo entre primeiro e último inscrito
    function getTimeToFill(users: { createdAt: Date }[]): number | null {
      if (users.length < 2) return null;

      let min = Infinity;
      let max = -Infinity;

      for (const u of users) {
        const t = new Date(u.createdAt).getTime();
        if (t < min) min = t;
        if (t > max) max = t;
      }

      return (max - min) / (1000 * 60 * 60);
    }

    let totalTimeUser = 0;
    let totalTimeWorker = 0;
    let countUser = 0;
    let countWorker = 0;

    events.forEach((event) => {
      const commonUsers = event.users.filter((u) => !u.user.worker);
      const workers = event.users.filter((u) => u.user.worker);

      const timeUser = getTimeToFill(commonUsers);
      const timeWorker = getTimeToFill(workers);

      if (timeUser !== null) {
        totalTimeUser += timeUser;
        countUser++;
      }

      if (timeWorker !== null) {
        totalTimeWorker += timeWorker;
        countWorker++;
      }
    });

    return {
      totalEvents,
      totalEventsActive,
      timeToFillHours: countUser
        ? Number((totalTimeUser / countUser).toFixed(2))
        : 0,
      timeToFillWorkerHours: countWorker
        ? Number((totalTimeWorker / countWorker).toFixed(2))
        : 0,
      eventsInCurrentQuarter,
    };
  }

  /**
   * Perfil do solicitante lido do banco, e não do JWT: o token dura 24h, então
   * um admin rebaixado continuaria enxergando evento de teste até ele expirar.
   * Mesma escolha do `RolesGuard`.
   */
  private async requesterIsAdmin(requesterId?: string): Promise<boolean> {
    if (!requesterId) return false;

    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { role: true },
    });

    return isAdminRole(requester?.role);
  }

  /** Barra quem não pode enxergar o evento — evento de teste responde 404 */
  private async assertEventIsVisible(eventId: string, requesterId?: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { status: true },
    });

    if (!event) {
      throw new NotFoundException('Event does not exist');
    }

    if (
      event.status === EventStatus.TEST &&
      !(await this.requesterIsAdmin(requesterId))
    ) {
      throw new NotFoundException('Event does not exist');
    }
  }

  /**
   * @param requesterId usuário autenticado que pediu a lista. Evento em teste
   * é ensaio de configuração, então some da lista de quem não é admin.
   */
  async findAll(filters?: Partial<EventDto>, requesterId?: string) {
    const canSeeTestEvents = await this.requesterIsAdmin(requesterId);

    const events = await this.prisma.event
      .findMany({
        where: {
          name: { contains: filters?.name || undefined },
          ...(canSeeTestEvents ? {} : { status: { not: EventStatus.TEST } }),
        },
        select: {
          id: true,
          type: true,
          name: true,
          startDate: true,
          endDate: true,
          status: true,
          data: true,
          groupRoles: {
            select: {
              capacity: true,
            },
          },
          _count: {
            select: {
              waitlist: true,
              bedrooms: true,
              Team: true,
              users: true,
            },
          },
        },
      })
      .then((events) => this.handlerReturnAllEvents(events));

    return events;
  }

  /**
   * @param requesterId usuário autenticado que abriu o evento. Ver `findAll`.
   * @param options.embedImages inclui logo e capa em base64 na resposta. Custa
   * ~1,5s por imagem em cache frio, então só quem gera PDF deve pedir — ver
   * `handlerReturnEvent`.
   */
  async findOne(
    id: string,
    requesterId?: string,
    options: { embedImages?: boolean } = {},
  ) {
    try {
      const event = await this.prisma.event.findUnique({
        where: { id },
        include: {
          groupRoles: {
            include: {
              roles: {
                include: {
                  _count: { select: { EventOnUsers: true, Waitlist: true } },
                },
              },
            },
          },
        },
      });

      if (!event) {
        throw new NotFoundException('Event does not exist');
      }

      if (
        event.status === EventStatus.TEST &&
        !(await this.requesterIsAdmin(requesterId))
      ) {
        // mesma resposta de evento inexistente: quem não pode ver o evento de
        // teste também não precisa descobrir que ele existe
        throw new NotFoundException('Event does not exist');
      }

      return this.handlerReturnEvent(event, options.embedImages ?? false);
    } catch (error) {
      throw error;
    }
  }
  async findOneClear(id: string) {
    return await this.prisma.event.findFirst({
      where: { id },
      include: {
        groupRoles: {
          include: {
            roles: true,
          },
        },
      },
    });
    //.then((event) => this.handlerReturnEvent(event));
  }

  async update(id: string, updateEvent: EventDto) {
    // valida os arquivos antes de qualquer escrita
    const coverExtension = updateEvent.coverFile
      ? resolveImageExtension(updateEvent.coverFile)
      : null;
    const logoExtension = updateEvent.logoFile
      ? resolveImageExtension(updateEvent.logoFile)
      : null;

    const event = await this.prisma.event.findUnique({
      where: { id },
      include: {
        groupRoles: {
          include: {
            roles: { include: { _count: { select: { EventOnUsers: true } } } },
          },
        },
      },
    });

    if (!event) throw new NotFoundException('Event does not exist');

    const name = updateEvent.name?.trim();

    if (!name) {
      throw new BadRequestException('O nome do evento é obrigatório');
    }

    // valida o nome antes dos uploads para não subir imagem de update que vai falhar
    await this.ensureEventNameIsAvailable(name, { ignoreEventId: id });

    // ================= UPLOADS (FORA DA TRANSACTION) =================
    let coverUrl = event.data?.['coverUrl'] ?? null;
    let logoUrl = event.data?.['logoUrl'] ?? null;
    let logoUrlInverted = event.data?.['logoUrlInverted'] ?? null;

    const [coverResult, logoResult] = await Promise.all([
      updateEvent.coverFile
        ? uploadImageFirebase(
            updateEvent.coverFile,
            `events/${event.id}/cover/cover.${coverExtension}`,
          )
        : null,
      updateEvent.logoFile
        ? uploadImageFirebase(
            updateEvent.logoFile,
            `events/${event.id}/logo/logo.${logoExtension}`,
          )
        : null,
    ]);

    if (coverResult) coverUrl = coverResult.url;
    if (logoResult) logoUrl = logoResult.url;

    if (updateEvent.logoFile) {
      const blackBuffer = await sharp(updateEvent.logoFile.buffer)
        .negate({ alpha: false })
        .greyscale()
        .tint({ r: 0, g: 0, b: 0 })
        .png()
        .toBuffer();

      const blackFile: Express.Multer.File = {
        ...updateEvent.logoFile,
        buffer: blackBuffer,
        mimetype: 'image/png',
      };

      logoUrlInverted = (
        await uploadImageFirebase(
          blackFile,
          `events/${event.id}/logo/logoInvert.png`,
        )
      ).url;
    }

    const safeData = structuredClone(updateEvent.data ?? {}) as Record<
      string,
      any
    >;
    const jsonData: Prisma.JsonObject = {
      ...safeData,
      coverUrl,
      logoUrl,
      logoUrlInverted,
    } as Prisma.JsonObject;

    const startDate = new Date(updateEvent.startDate);
    const endDate = new Date(updateEvent.endDate);

    // ================= TRANSACTION SOMENTE PARA BANCO =================
    const ops: Prisma.PrismaPromise<any>[] = [];

    // Atualiza o evento
    ops.push(
      this.prisma.event.update({
        where: { id },
        data: {
          type: updateEvent.type,
          name,
          startDate,
          endDate,
          status: updateEvent.status,
          groupLink: updateEvent.groupLink,
          data: jsonData,
        },
      }),
    );

    if (updateEvent.groupRoles?.length) {
      const dbGroups = new Map(event.groupRoles.map((g) => [g.id, g]));

      const incomingGroups = new Map(
        updateEvent.groupRoles.filter((g) => g.id).map((g) => [g.id!, g]),
      );

      // REMOVER GRUPOS AUSENTES
      for (const group of dbGroups.values()) {
        if (!incomingGroups.has(group.id)) {
          const hasUsers = group.roles.some((r) => r._count.EventOnUsers > 0);
          if (hasUsers) {
            throw new BadRequestException(
              `Group "${group.name}" has registered users and cannot be removed`,
            );
          }
          ops.push(this.prisma.groupRoles.delete({ where: { id: group.id } }));
        }
      }

      // CRIAR / ATUALIZAR GRUPOS E ROLES
      for (const group of updateEvent.groupRoles) {
        let groupId = group.id;

        if (groupId && dbGroups.has(groupId)) {
          ops.push(
            this.prisma.groupRoles.update({
              where: { id: groupId },
              data: {
                name: group.name,
                capacity: group.capacity,
                link: this.normalizeGroupLink(group.link),
              },
            }),
          );
        } else {
          const created = await this.prisma.groupRoles.create({
            data: {
              name: group.name,
              capacity: group.capacity,
              link: this.normalizeGroupLink(group.link),
              eventId: id,
            },
          });
          groupId = created.id;
        }

        const dbRoles = dbGroups.get(groupId)?.roles ?? [];
        const incomingRoles = new Map(
          group.roles.filter((r) => r.id).map((r) => [r.id!, r]),
        );

        // REMOVER ROLES AUSENTES
        for (const role of dbRoles) {
          if (!incomingRoles.has(role.id)) {
            if (role._count.EventOnUsers > 0) {
              throw new BadRequestException(
                `Role "${role.description}" already has users and cannot be removed`,
              );
            }
            ops.push(
              this.prisma.rolesRegistration.delete({ where: { id: role.id } }),
            );
          }
        }

        // CRIAR / ATUALIZAR ROLES
        for (const role of group.roles) {
          if (role.id) {
            ops.push(
              this.prisma.rolesRegistration.update({
                where: { id: role.id },
                data: { description: role.description, price: role.price },
              }),
            );
          } else {
            ops.push(
              this.prisma.rolesRegistration.create({
                data: {
                  description: role.description,
                  price: role.price,
                  groupId,
                },
              }),
            );
          }
        }
      }
    }

    // Executa TODAS as operações em uma transaction segura
    await this.prisma.$transaction(ops);

    return this.findOneClear(id);
  }

  async removeUserFromEvent(
    idUser: string,
    idEvent: string,
    roleRegistrationId: string,
  ) {
    const [userExists, eventExists, registrationExists] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: idUser },
        select: { id: true },
      }),
      this.prisma.event.findUnique({
        where: { id: idEvent },
        select: { id: true },
      }),
      this.prisma.eventOnUsersRolesRegistration.findFirst({
        where: { userId: idUser, eventId: idEvent, roleRegistrationId },
        select: { userId: true },
      }),
    ]);

    if (!userExists) {
      throw new NotFoundException('User does not exist!');
    }
    if (!eventExists) {
      throw new NotFoundException('Event does not exist!');
    }
    if (!registrationExists) {
      throw new NotFoundException('Registration does not exist!');
    }

    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const paymentCheckouts = await tx.paymentCheckout.deleteMany({
          where: { payment: { userId: idUser, eventId: idEvent } },
        });
        const payments = await tx.payment.deleteMany({
          where: { userId: idUser, eventId: idEvent },
        });
        const bedroomUsers = await tx.bedroomsOnUsers.deleteMany({
          where: { userId: idUser, bedrooms: { eventId: idEvent } },
        });
        const teamUsers = await tx.teamOnUsers.deleteMany({
          where: { userId: idUser, team: { eventId: idEvent } },
        });
        const waitlist = await tx.waitlist.deleteMany({
          where: { userId: idUser, eventId: idEvent },
        });
        const registrations = await tx.eventOnUsersRolesRegistration.deleteMany(
          {
            where: { userId: idUser, eventId: idEvent },
          },
        );
        const eventUsers = await tx.eventOnUsers.deleteMany({
          where: { userId: idUser, eventId: idEvent },
        });

        return {
          paymentCheckouts: paymentCheckouts.count,
          payments: payments.count,
          bedroomUsers: bedroomUsers.count,
          teamUsers: teamUsers.count,
          waitlist: waitlist.count,
          registrations: registrations.count,
          eventUsers: eventUsers.count,
        };
      },
      { maxWait: 10000, timeout: 60000 },
    );

    return { message: 'User removed from event successfully', deleted };
  }

  async remove(id: string, requesterId: string) {
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { role: true },
    });

    if (!requester) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (!isAdminRole(requester.role)) {
      throw new UnauthorizedException('Usuário não é administrador');
    }

    const event = await this.prisma.event.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!event) {
      throw new NotFoundException('Event does not exist!');
    }

    const userCount = await this.prisma.eventOnUsers.count({
      where: { eventId: id },
    });

    if (userCount > 0) {
      throw new BadRequestException(
        'Cannot delete event with registered users!',
      );
    }

    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const paymentCheckouts = await tx.paymentCheckout.deleteMany({
          where: { payment: { eventId: id } },
        });
        const payments = await tx.payment.deleteMany({
          where: { eventId: id },
        });
        const bedroomUsers = await tx.bedroomsOnUsers.deleteMany({
          where: { bedrooms: { eventId: id } },
        });
        const teamUsers = await tx.teamOnUsers.deleteMany({
          where: { team: { eventId: id } },
        });
        const waitlist = await tx.waitlist.deleteMany({
          where: { eventId: id },
        });
        const registrations = await tx.eventOnUsersRolesRegistration.deleteMany(
          {
            where: { eventId: id },
          },
        );
        const eventUsers = await tx.eventOnUsers.deleteMany({
          where: { eventId: id },
        });
        const roles = await tx.rolesRegistration.deleteMany({
          where: { group: { eventId: id } },
        });
        const groups = await tx.groupRoles.deleteMany({
          where: { eventId: id },
        });
        const bedrooms = await tx.bedrooms.deleteMany({
          where: { eventId: id },
        });
        const teams = await tx.team.deleteMany({
          where: { eventId: id },
        });

        await tx.event.delete({ where: { id } });

        return {
          paymentCheckouts: paymentCheckouts.count,
          payments: payments.count,
          bedroomUsers: bedroomUsers.count,
          teamUsers: teamUsers.count,
          waitlist: waitlist.count,
          registrations: registrations.count,
          eventUsers: eventUsers.count,
          roles: roles.count,
          groups: groups.count,
          bedrooms: bedrooms.count,
          teams: teams.count,
        };
      },
      { maxWait: 10000, timeout: 60000 },
    );

    return {
      message: `Event ${event.name} deleted successfully`,
      eventId: event.id,
      deleted,
    };
  }

  async findUsers(eventId: string) {
    return this.prisma.eventOnUsers
      .findMany({
        where: { eventId },
        orderBy: { createdAt: 'asc' },

        include: {
          user: {
            include: {
              bedrooms: {
                where: {
                  bedrooms: {
                    eventId,
                  },
                },
                include: {
                  bedrooms: true,
                },
              },

              TeamOnUsers: {
                where: {
                  team: {
                    eventId,
                  },
                },
                include: {
                  team: true,
                },
              },
            },
          },

          rolesRegistration: {
            include: {
              role: {
                include: {
                  group: true,
                },
              },
            },
          },
        },
      })
      .then((data) => this.handleformatUsers(data));
  }

  async findUsersInWaitlist(idEvent: string) {
    return this.prisma.waitlist
      .findMany({
        where: {
          eventId: idEvent,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              cpf: true,
              cellphone: true,
              badgeName: true,
              birthday: true,
              city: true,
              neighborhood: true,
              profilePhotoUrl: true,
            },
          },
          rolesRegistration: {
            select: {
              id: true,
              description: true,
              price: true,
              group: { select: { id: true, name: true } },
            },
          },
        },
      })
      .then((data) => this.handleformatUsersWaitlist(data));
  }
  async removeUserFromWaitlist(
    idUser: string,
    idEvent: string,
    roleRegistrationId: string,
  ) {
    const waitlistEntry = await this.prisma.waitlist.findFirst({
      where: { userId: idUser, eventId: idEvent, roleRegistrationId },
    });

    if (!waitlistEntry) {
      throw new NotFoundException('Waitlist entry does not exist!');
    }

    await this.prisma.waitlist
      .delete({
        where: { id: waitlistEntry.id },
      })
      .catch((err) => {
        this.logger.error(
          `Falha ao remover usuário da waitlist (user=${idUser}, event=${idEvent})`,
          err instanceof Error ? err.stack : String(err),
        );
        throw new InternalServerErrorException();
      });
  }
  async movedUserFromWaitlistToEvent(
    userId: string,
    userRemovedId: string,
    eventId: string,
    roleRegistrationId: string,
  ) {
    if (!userRemovedId || !userId) {
      throw new BadRequestException('User IDs must be provided!');
    }
    return await this.prisma.$transaction(
      async (tx) => {
        const waitlistEntry = await tx.waitlist.findFirst({
          where: { userId, eventId, roleRegistrationId },
        });

        if (!waitlistEntry) {
          throw new NotFoundException('Waitlist entry does not exist!');
        }

        await tx.waitlist.delete({
          where: { id: waitlistEntry.id },
        });

        // obter o grupo do rule
        const roleRegistration = await tx.rolesRegistration.findUnique({
          where: { id: roleRegistrationId },
          include: { group: true },
        });

        if (!roleRegistration) {
          throw new NotFoundException('Role registration not found!');
        }
        // remover  regitro do usuario removido para o mesmo grupo da role que vai ser registrada para o usuario da waitlist
        await tx.eventOnUsersRolesRegistration.deleteMany({
          where: {
            userId: userRemovedId,
            eventId,
            role: {
              groupId: roleRegistration.groupId,
            },
          },
        });
        //verifica se onevents tem agum role registrado para o usuario removido, se não tiver, remove a relação do usuario com o evento
        await tx.eventOnUsers.deleteMany({
          where: {
            userId: userRemovedId,
            eventId,
            rolesRegistration: { none: {} },
          },
        });

        const registration = await this.registerUserInEvent(
          userId,
          eventId,
          [waitlistEntry.roleRegistrationId],
          { tx, movingFromWaitlist: true },
        );
        if (registration[0].type === 'WAITLIST') {
          // se ainda ficou na waitlist, deve falar o tx
          throw new BadRequestException(
            'Não há vagas disponíveis no evento para nesse grupo',
          );
        }

        return registration;
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 60000 },
    );
  }
  async removeUserFromEventWaitlist(
    idUser: string,
    idEvent: string,
    roleRegistrationId: string,
  ) {
    const waitlistEntries = await this.prisma.waitlist.findUnique({
      where: {
        userId_eventId_roleRegistrationId: {
          userId: idUser,
          eventId: idEvent,
          roleRegistrationId: roleRegistrationId,
        },
      },
    });

    if (!waitlistEntries) {
      throw new NotFoundException(
        'No waitlist entries found for this user in the event!',
      );
    }

    const response = await this.prisma.waitlist.delete({
      where: {
        userId_eventId_roleRegistrationId: {
          userId: idUser,
          eventId: idEvent,
          roleRegistrationId: roleRegistrationId,
        },
      },
    });
    return response;
  }
}
