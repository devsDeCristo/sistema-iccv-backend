import { Injectable } from '@nestjs/common';
import {
  CheckinStatus,
  EventStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ADMIN_AREA_ROLES, Role } from 'src/auth/roles';
import {
  perfilNaIgreja,
  SELECT_TENANT,
  TenantRequester,
  tenantChurchIds,
} from 'src/auth/tenant';

/** Estados de pagamento que ainda contam como dinheiro do evento. */
const ESTADOS_VIVOS = [
  PaymentStatus.PAID,
  PaymentStatus.IN_ANALYSIS,
  PaymentStatus.WAITING,
];

/**
 * Eventos que o painel considera "abertos": ligados ao público ou em ensaio.
 * Inativo é evento desligado — ele existe, mas não é o que alguém acompanha.
 */
const ABERTOS = [EventStatus.ACTIVE, EventStatus.TEST];

/**
 * Fuso em que os gráficos agrupam os dias e os meses.
 *
 * O Prisma grava `timestamp` em UTC, e o Postgres agrupa nele. As chaves da
 * série, do outro lado, são geradas em hora local pelo Node. Sem alinhar os
 * dois, tudo que acontece depois das 21h em Brasília cai no balde do dia
 * seguinte e some do gráfico — o intervalo inteiro entre as 21h e a meia-noite
 * ficava invisível todo dia.
 */
const FUSO = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A coluna lida como data local, para `date_trunc` cair no dia certo.
 *
 * São dois passos porque a coluna é `timestamp without time zone` guardando
 * UTC: o primeiro `AT TIME ZONE 'UTC'` diz em que fuso ela está, o segundo
 * converte para o nosso.
 */
const emHoraLocal = (coluna: string): Prisma.Sql =>
  Prisma.sql`(${Prisma.raw(
    `"${coluna}"`,
  )} AT TIME ZONE 'UTC') AT TIME ZONE ${FUSO}`;

type Fase = 'ongoing' | 'upcoming' | 'finished';

type EventoBase = {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  status: EventStatus;
  church: { id: string; name: string };
};

/** Começo do dia de hoje — a régua das duas pontas do evento. */
function hoje(): Date {
  const data = new Date();
  data.setHours(0, 0, 0, 0);
  return data;
}

/**
 * Em que ponto o evento está, contando o dia inteiro nas duas pontas.
 *
 * Comparar o horário cravado tiraria da lista o evento que começa hoje de
 * manhã e o que termina hoje à tarde — nos dois casos ele ainda está
 * acontecendo para quem está lá. É a mesma régua do `emAndamento` do painel.
 */
function faseDoEvento(evento: { startDate: Date; endDate: Date }): Fase {
  const inicio = new Date(evento.startDate);
  inicio.setHours(0, 0, 0, 0);
  const fim = new Date(evento.endDate);
  fim.setHours(23, 59, 59, 999);

  const agora = new Date();
  if (agora > fim) return 'finished';
  if (agora >= inicio) return 'ongoing';
  return 'upcoming';
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A tela de abertura do painel.
   *
   * O eixo é o evento, e não o sistema. Somar inscritos, vagas ou dinheiro de
   * todos os eventos de todos os anos dá um número grande que não decide nada:
   * "1.135 inscritos" mistura o cursilho de 2024 com o que abre semana que vem.
   * Aqui cada número mora dentro do evento a que pertence, e o evento que
   * merece a tela vem separado dos outros.
   *
   * A home tem dois formatos. Quem administra igreja (admin e financeiro) vê a
   * dela; quem atravessa todas (super admin e dev) vê o sistema, e mesmo lá a
   * leitura é por igreja, com o evento em foco de cada uma.
   */
  async overview(requesterId?: string) {
    const requester = requesterId
      ? await this.prisma.user.findUnique({
          where: { id: requesterId },
          select: SELECT_TENANT,
        })
      : null;

    // `null` aqui é super admin/dev: nenhum recorte a aplicar. Lista vazia é
    // admin sem vínculo nenhum, que não alcança igreja alguma — e o `in: []`
    // logo abaixo é justamente o que fecha a porta para ele.
    const churchIds = tenantChurchIds(requester, ADMIN_AREA_ROLES);
    const todasAsIgrejas = churchIds === null;
    const perfil = requester?.role ?? null;

    const doRecorte: Prisma.EventWhereInput = todasAsIgrejas
      ? {}
      : { churchId: { in: churchIds } };

    /** Publicar notícia é do admin: o financeiro não entra no mural */
    const veMural = !todasAsIgrejas && perfil !== Role.FINANCE;

    const ehDev = perfil === Role.DEV;

    const [abertos, churches, recentRegistrations, news] = await Promise.all([
      this.eventosAbertos(doRecorte),
      todasAsIgrejas ? null : this.minhasIgrejas(requester, churchIds),
      this.inscricoesRecentes(doRecorte),
      veMural ? this.mural(churchIds) : null,
    ]);

    // os indicadores do sistema são do dev: é o perfil que cuida da operação
    // inteira, e é o único que já enxerga o registro de atividades
    const insights = ehDev ? await this.indicadores() : null;

    /**
     * O cartão em foco é de quem tem um evento na mão.
     *
     * Super admin e dev não têm: o evento mais próximo do sistema é de uma
     * igreja que não é deles, e dar a ele a tela inteira é destacar o que por
     * acaso começa primeiro. Para esses dois todos os eventos abertos entram na
     * lista, lado a lado e do mesmo tamanho.
     *
     * Para admin e financeiro, sem nenhum evento aberto a tela não fica vazia:
     * o último que encerrou é exatamente o que eles querem ver no dia seguinte
     * ao evento — quantos vieram, quanto entrou, quem ficou na espera.
     */
    const emFoco = todasAsIgrejas
      ? null
      : abertos.length
      ? abertos[0]
      : await this.ultimoEncerrado(doRecorte);

    const outros = abertos.filter((evento) => evento.id !== emFoco?.id);

    return {
      scope: todasAsIgrejas ? 'system' : 'church',
      role: perfil,
      churches,
      spotlight: emFoco,
      pending: this.pendencias([emFoco, ...outros], perfil, todasAsIgrejas),
      /**
       * A home do dev é de operação: gráficos, igrejas e atividade. A lista de
       * eventos abertos sai porque a de igrejas já mostra o evento em foco de
       * cada uma, e quem acabou de se inscrever numa igreja é assunto de quem
       * administra aquela igreja — não de quem cuida do sistema.
       *
       * `outros` continua sendo calculado acima: as pendências saem dele.
       */
      otherEvents: ehDev ? null : outros,
      recentRegistrations: ehDev ? null : recentRegistrations,
      news,
      byChurch: todasAsIgrejas ? await this.igrejasDoSistema() : null,
      insights,
    };
  }

  /**
   * Os eventos abertos, já detalhados e na ordem em que interessam: o que está
   * acontecendo primeiro, depois os que começam mais cedo. O primeiro da lista
   * é o que fica em foco na tela.
   */
  private async eventosAbertos(recorte: Prisma.EventWhereInput) {
    const eventos = await this.prisma.event.findMany({
      where: { ...recorte, status: { in: ABERTOS }, endDate: { gte: hoje() } },
      orderBy: { startDate: 'asc' },
      select: this.selectDoEvento(),
    });

    const detalhados = await this.detalhar(eventos);

    // acontecendo agora ganha do que ainda vai começar; o resto mantém a ordem
    // de início que veio do banco
    return detalhados.sort((a, b) => {
      const peso = (fase: Fase) => (fase === 'ongoing' ? 0 : 1);
      return peso(a.phase) - peso(b.phase);
    });
  }

  /** O último evento que terminou, para a tela não abrir vazia entre um e outro. */
  private async ultimoEncerrado(recorte: Prisma.EventWhereInput) {
    const evento = await this.prisma.event.findFirst({
      where: { ...recorte, endDate: { lt: hoje() } },
      orderBy: { endDate: 'desc' },
      select: this.selectDoEvento(),
    });

    if (!evento) return null;

    const [detalhado] = await this.detalhar([evento]);
    return detalhado;
  }

  private selectDoEvento() {
    return {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      status: true,
      church: { select: { id: true, name: true } },
    } as const;
  }

  /**
   * Preenche os números de um punhado de eventos.
   *
   * Tudo em consulta agrupada sobre o conjunto, e não um `findMany` por evento:
   * são cinco perguntas no total, independente de a home mostrar um evento ou
   * seis.
   */
  private async detalhar(eventos: EventoBase[]) {
    if (!eventos.length) return [];

    const ids = eventos.map((evento) => evento.id);

    const seteDias = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const catorzeDias = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [grupos, pessoas, espera, pagamentos, checkins, ritmo] =
      await Promise.all([
        /**
         * Ocupação por grupo de inscrição — a leitura que o admin realmente faz.
         * A capacidade mora no grupo (`group_roles.capacity`), e é lá que "lotado"
         * quer dizer alguma coisa: um cursilho com 78/78 na equipe e 67/70 nos
         * cursilhistas está em situação bem diferente de 145/148 no total.
         *
         * SQL cru porque a contagem atravessa dois níveis (grupo → tipo de
         * inscrição → inscrição), e o `groupBy` do client não atravessa relação.
         */
        this.prisma.$queryRaw<
          {
            eventId: string;
            groupId: string;
            name: string;
            capacity: number | null;
            taken: number;
          }[]
        >`
        SELECT g."eventId", g."id" AS "groupId", g."name", g."capacity",
               count(r.*)::int AS taken
        FROM "group_roles" g
        LEFT JOIN "roles_registration_types" t ON t."groupId" = g."id"
        LEFT JOIN "EventOnUsersRolesRegistration" r
          ON r."roleRegistrationId" = t."id"
        WHERE g."eventId" IN (${Prisma.join(ids)})
        GROUP BY g."eventId", g."id", g."name", g."capacity"
        ORDER BY g."name"
      `,
        this.prisma.eventOnUsers.groupBy({
          by: ['eventId'],
          where: { eventId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.waitlist.groupBy({
          by: ['eventId'],
          where: { eventId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.payment.groupBy({
          by: ['eventId', 'status'],
          where: { eventId: { in: ids }, status: { in: ESTADOS_VIVOS } },
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.checkin.groupBy({
          by: ['eventId', 'status'],
          where: { eventId: { in: ids } },
          _count: { _all: true },
        }),
        /**
         * Ritmo: quantas inscrições entraram na última semana e na anterior.
         *
         * É o número que muda a leitura de todos os outros. "9 de 200 vagas" com
         * oito dias para começar não diz se o evento está enchendo devagar ou
         * parado — uma inscrição na semana diz, e é cedo o bastante para o admin
         * fazer alguma coisa a respeito.
         */
        this.prisma.$queryRaw<
          { eventId: string; last7: number; prev7: number }[]
        >`
        SELECT "eventId",
               count(*) FILTER (WHERE "createdAt" >= ${seteDias})::int AS "last7",
               count(*) FILTER (
                 WHERE "createdAt" >= ${catorzeDias} AND "createdAt" < ${seteDias}
               )::int AS "prev7"
        FROM "EventOnUsers"
        WHERE "eventId" IN (${Prisma.join(ids)})
        GROUP BY "eventId"
      `,
      ]);

    return eventos.map((evento) => {
      const doEvento = grupos.filter((linha) => linha.eventId === evento.id);

      /**
       * Só os grupos com capacidade definida entram na conta de vagas: somar
       * um grupo sem teto empurraria a ocupação para baixo e faria um evento
       * lotado parecer com espaço. Evento antigo, de antes de a capacidade
       * existir, cai no `null` e a tela mostra só o número de inscritos.
       */
      const comTeto = doEvento.filter((grupo) => grupo.capacity !== null);
      const total = comTeto.reduce((soma, grupo) => soma + grupo.capacity, 0);

      const porStatus = (
        status: PaymentStatus,
      ): { count: number; amount: number } => {
        const linha = pagamentos.find(
          (item) => item.eventId === evento.id && item.status === status,
        );
        return {
          count: linha?._count._all ?? 0,
          amount: linha?._sum.amount ?? 0,
        };
      };

      const paid = porStatus(PaymentStatus.PAID);
      const inAnalysis = porStatus(PaymentStatus.IN_ANALYSIS);
      const waiting = porStatus(PaymentStatus.WAITING);

      const doCheckin = checkins.filter((linha) => linha.eventId === evento.id);
      const checkinsFeitos =
        doCheckin.find((linha) => linha.status === CheckinStatus.DONE)?._count
          ._all ?? 0;
      const checkinsAbertos = doCheckin.reduce(
        (soma, linha) => soma + linha._count._all,
        0,
      );

      const inscritos =
        pessoas.find((linha) => linha.eventId === evento.id)?._count._all ?? 0;

      const passo = ritmo.find((linha) => linha.eventId === evento.id);

      return {
        id: evento.id,
        name: evento.name,
        startDate: evento.startDate,
        endDate: evento.endDate,
        status: evento.status,
        church: evento.church,
        phase: faseDoEvento(evento),

        /** Pessoas distintas inscritas no evento */
        people: inscritos,

        /**
         * Vagas ocupadas e totais. A ocupada é a inscrição por tipo, e não a
         * pessoa: a capacidade é definida por grupo, e alguém inscrito em dois
         * grupos ocupa duas vagas. `total` nulo é evento sem capacidade
         * configurada — a tela não inventa uma barra nesse caso.
         */
        seats: {
          taken: doEvento.reduce((soma, g) => soma + g.taken, 0),
          total: total || null,
        },

        groups: doEvento.map((grupo) => ({
          id: grupo.groupId,
          name: grupo.name,
          capacity: grupo.capacity,
          taken: grupo.taken,
        })),

        waitlist:
          espera.find((linha) => linha.eventId === evento.id)?._count._all ?? 0,

        /**
         * Caixa do evento. `expected` é o que foi cobrado e ainda vale —
         * recusado, cancelado e estornado ficam de fora porque nenhum deles é
         * dinheiro a caminho.
         */
        finance: {
          paid,
          inAnalysis,
          waiting,
          expected: paid.amount + inAnalysis.amount + waiting.amount,
        },

        /** Inscrições na última semana e na anterior, para comparar */
        pace: { last7: passo?.last7 ?? 0, previous7: passo?.prev7 ?? 0 },

        /** Nulo enquanto o check-in não começou: zero de N seria alarme falso */
        checkin: checkinsAbertos
          ? { done: checkinsFeitos, total: inscritos }
          : null,
      };
    });
  }

  /**
   * O que espera uma ação, sempre amarrado ao evento em que aconteceu.
   *
   * É a diferença entre "6 comprovantes em análise" — que não diz onde nem o
   * que fazer — e "45° Cursilho: 6 comprovantes esperando conferência", que é
   * uma tarefa com endereço.
   */
  private pendencias(
    eventos: (
      | Awaited<ReturnType<DashboardService['detalhar']>>[number]
      | null
    )[],
    perfil: number | null,
    todasAsIgrejas: boolean,
  ) {
    const lista: {
      kind: 'receipts' | 'waitlist';
      eventId: string;
      eventName: string;
      churchName: string;
      count: number;
      amount?: number;
      /** Vagas livres — só faz sentido junto da lista de espera */
      seatsOpen?: number;
    }[] = [];

    for (const evento of eventos) {
      // evento encerrado não gera tarefa: conferir comprovante de quem já foi
      // não muda mais nada na operação
      if (!evento || evento.phase === 'finished') continue;

      if (evento.finance.inAnalysis.count > 0) {
        lista.push({
          kind: 'receipts',
          eventId: evento.id,
          eventName: evento.name,
          churchName: evento.church.name,
          count: evento.finance.inAnalysis.count,
          amount: evento.finance.inAnalysis.amount,
        });
      }

      /**
       * Lista de espera só vira tarefa quando existe vaga para chamar alguém —
       * fila em evento lotado é situação normal, não pendência. O financeiro
       * fica de fora: quem chama da lista é quem administra.
       */
      const livres =
        evento.seats.total === null
          ? 0
          : evento.seats.total - evento.seats.taken;

      const gerenciaInscricao = todasAsIgrejas || perfil !== Role.FINANCE;

      if (gerenciaInscricao && evento.waitlist > 0 && livres > 0) {
        lista.push({
          kind: 'waitlist',
          eventId: evento.id,
          eventName: evento.name,
          churchName: evento.church.name,
          count: evento.waitlist,
          seatsOpen: livres,
        });
      }
    }

    return lista;
  }

  /**
   * As igrejas da pessoa, com o perfil que ela tem em cada uma — quem é admin
   * de uma e financeiro de outra precisa ver os dois chapéus, e não só o mais
   * alto que ficou em `User.role`.
   */
  private async minhasIgrejas(
    requester: TenantRequester | null,
    churchIds: string[],
  ) {
    if (!churchIds.length) return [];

    const igrejas = await this.prisma.church.findMany({
      where: { id: { in: churchIds } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return igrejas.map((igreja) => ({
      ...igreja,
      role: perfilNaIgreja(requester, igreja.id),
    }));
  }

  /**
   * A leitura por igreja da home de super admin e dev.
   *
   * Cada linha mostra o evento em foco daquela igreja, e não o total histórico
   * dela: "3 eventos, 812 inscritos desde 2024" não diz se a igreja está
   * parada ou com um evento lotando amanhã.
   */
  private async igrejasDoSistema() {
    const igrejas = await this.prisma.church.findMany({
      select: { id: true, name: true, _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });

    const abertos = await this.prisma.event.findMany({
      where: { status: { in: ABERTOS }, endDate: { gte: hoje() } },
      orderBy: { startDate: 'asc' },
      select: this.selectDoEvento(),
    });

    // um evento por igreja: o primeiro da ordem, que é o mais próximo
    const emFocoPorIgreja = new Map<string, EventoBase>();
    for (const evento of abertos) {
      if (!emFocoPorIgreja.has(evento.church.id)) {
        emFocoPorIgreja.set(evento.church.id, evento);
      }
    }

    const detalhados = await this.detalhar([...emFocoPorIgreja.values()]);
    const porIgreja = new Map(
      detalhados.map((evento) => [evento.church.id, evento]),
    );

    return igrejas.map((igreja) => {
      const evento = porIgreja.get(igreja.id);

      return {
        id: igreja.id,
        name: igreja.name,
        /** Quem entra no painel dela — inscrito não pertence a igreja nenhuma */
        admins: igreja._count.users,
        openEvents: abertos.filter((aberto) => aberto.church.id === igreja.id)
          .length,
        spotlight: evento
          ? {
              id: evento.id,
              name: evento.name,
              startDate: evento.startDate,
              phase: evento.phase,
              people: evento.people,
              seats: evento.seats,
            }
          : null,
      };
    });
  }

  /**
   * Quem entrou por último, com o evento em que entrou.
   *
   * É o pulso da tela: o contador de inscritos diz onde o evento chegou, e
   * esta lista diz se ele ainda se move. Uma sem a outra deixa o admin sem
   * saber se os números de hoje são os mesmos de ontem.
   */
  private async inscricoesRecentes(recorte: Prisma.EventWhereInput) {
    const inscricoes = await this.prisma.eventOnUsers.findMany({
      where: { event: recorte },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        createdAt: true,
        user: { select: { id: true, fullName: true, profilePhotoUrl: true } },
        event: { select: { id: true, name: true } },
      },
    });

    return inscricoes.map((inscricao) => ({
      userId: inscricao.user.id,
      name: inscricao.user.fullName,
      photoUrl: inscricao.user.profilePhotoUrl,
      eventId: inscricao.event.id,
      eventName: inscricao.event.name,
      createdAt: inscricao.createdAt,
    }));
  }

  /**
   * O mural da igreja: o que foi anunciado por último e o que ficou pela
   * metade.
   *
   * O rascunho entra junto de propósito — notícia escrita e não publicada é a
   * que ninguém lembra que existe, e ela some da tela de notícias no meio das
   * publicadas.
   */
  private async mural(churchIds: string[]) {
    if (!churchIds.length) return { items: [], drafts: 0 };

    const [items, drafts] = await Promise.all([
      this.prisma.news.findMany({
        where: { churchId: { in: churchIds }, isPublished: true },
        orderBy: { publishedAt: 'desc' },
        take: 3,
        select: {
          id: true,
          title: true,
          publishedAt: true,
          event: { select: { id: true, name: true } },
        },
      }),
      this.prisma.news.count({
        where: { churchId: { in: churchIds }, isPublished: false },
      }),
    ]);

    return {
      items: items.map((noticia) => ({
        id: noticia.id,
        title: noticia.title,
        publishedAt: noticia.publishedAt,
        /** Nulo é aviso geral; preenchido restringe o mural ao evento */
        eventName: noticia.event?.name ?? null,
      })),
      drafts,
    };
  }

  /**
   * Os indicadores do sistema, para a home do dev.
   *
   * São as perguntas que ninguém responde olhando um evento de cada vez: o
   * movimento está crescendo ou caindo, qual igreja carrega o sistema, quem
   * está operando o painel.
   *
   * Uma nota sobre "quem mais usa": o sistema **não registra acesso**. Não há
   * campo de último login nem log de entrada — a tabela `logs` guarda escritas,
   * gravadas por middleware do Prisma. Então o que sai daqui é quem mais
   * *movimenta* o sistema, e não quem mais entra nele. Medir acesso de verdade
   * pede uma coluna nova; até lá o rótulo da tela diz exatamente isto.
   */
  private async indicadores() {
    const inicioDoMes = new Date();
    inicioDoMes.setDate(1);
    inicioDoMes.setHours(0, 0, 0, 0);

    /** Onze meses atrás mais o corrente: a série fecha um ano na tela */
    const primeiroMes = new Date(inicioDoMes);
    primeiroMes.setMonth(primeiroMes.getMonth() - 11);

    const primeiroDia = new Date();
    primeiroDia.setHours(0, 0, 0, 0);
    primeiroDia.setDate(primeiroDia.getDate() - 13);

    const trintaDias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [porMes, porDia, logins, igrejas, inscritosPorIgreja, atores] =
      await Promise.all([
        this.prisma.$queryRaw<{ mes: string; total: number }[]>`
          SELECT to_char(date_trunc('month', ${emHoraLocal(
            'createdAt',
          )}), 'YYYY-MM') AS mes,
                 count(*)::int AS total
          FROM "EventOnUsers"
          WHERE "createdAt" >= ${primeiroMes}
          GROUP BY 1 ORDER BY 1
        `,
        this.prisma.$queryRaw<{ dia: string; total: number }[]>`
          SELECT to_char(date_trunc('day', ${emHoraLocal(
            'createdAt',
          )}), 'YYYY-MM-DD') AS dia,
                 count(*)::int AS total
          FROM "logs"
          WHERE "createdAt" >= ${primeiroDia}
          GROUP BY 1 ORDER BY 1
        `,
        /**
         * Tentativas de entrada por dia, separadas em sucesso e falha.
         *
         * A tabela só existe desde a migration que a criou, e não havia como
         * reconstruir o que nunca foi gravado — dia anterior a ela vem zerado
         * porque não há registro, não porque ninguém entrou.
         */
        this.prisma.$queryRaw<
          { dia: string; sucessos: number; falhas: number }[]
        >`
          SELECT to_char(date_trunc('day', ${emHoraLocal(
            'createdAt',
          )}), 'YYYY-MM-DD') AS dia,
                 count(*) FILTER (WHERE "success")::int AS sucessos,
                 count(*) FILTER (WHERE NOT "success")::int AS falhas
          FROM "login_attempts"
          WHERE "createdAt" >= ${primeiroDia}
          GROUP BY 1 ORDER BY 1
        `,
        this.prisma.church.findMany({
          select: {
            id: true,
            name: true,
            _count: { select: { events: true } },
          },
        }),
        this.prisma.$queryRaw<{ churchId: string; total: number }[]>`
          SELECT e."churchId", count(*)::int AS total
          FROM "EventOnUsers" inscricao
          JOIN "events" e ON e."id" = inscricao."eventId"
          GROUP BY e."churchId"
        `,
        this.prisma.$queryRaw<{ userId: string; total: number }[]>`
          SELECT "userId", count(*)::int AS total
          FROM "logs"
          WHERE "userId" IS NOT NULL AND "createdAt" >= ${trintaDias}
          GROUP BY "userId" ORDER BY total DESC LIMIT 5
        `,
      ]);

    /**
     * Mês sem inscrição nenhuma não some da série: o buraco é o dado. Sem
     * preencher, doze meses com três movimentados viram três colunas coladas e
     * a linha do tempo mente sobre o intervalo entre elas.
     */
    const meses: { key: string; total: number }[] = [];
    for (let i = 0; i < 12; i += 1) {
      const data = new Date(primeiroMes);
      data.setMonth(data.getMonth() + i);
      const key = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(
        2,
        '0',
      )}`;
      meses.push({
        key,
        total: porMes.find((linha) => linha.mes === key)?.total ?? 0,
      });
    }

    const dias: { key: string; total: number }[] = [];
    for (let i = 0; i < 14; i += 1) {
      const data = new Date(primeiroDia);
      data.setDate(data.getDate() + i);
      const key = data.toISOString().slice(0, 10);
      dias.push({
        key,
        total: porDia.find((linha) => linha.dia === key)?.total ?? 0,
      });
    }

    const tentativas: { key: string; success: number; failure: number }[] = [];
    for (let i = 0; i < 14; i += 1) {
      const data = new Date(primeiroDia);
      data.setDate(data.getDate() + i);
      const key = data.toISOString().slice(0, 10);
      const linha = logins.find((item) => item.dia === key);
      tentativas.push({
        key,
        success: linha?.sucessos ?? 0,
        failure: linha?.falhas ?? 0,
      });
    }

    const pessoas = atores.length
      ? await this.prisma.user.findMany({
          where: { id: { in: atores.map((ator) => ator.userId) } },
          select: {
            id: true,
            fullName: true,
            profilePhotoUrl: true,
            role: true,
          },
        })
      : [];

    const porIgreja = new Map(
      inscritosPorIgreja.map((linha) => [linha.churchId, linha.total]),
    );

    return {
      registrationsByMonth: meses,
      activityByDay: dias,
      loginsByDay: tentativas,
      topChurches: igrejas
        .map((igreja) => ({
          id: igreja.id,
          name: igreja.name,
          events: igreja._count.events,
          registrations: porIgreja.get(igreja.id) ?? 0,
        }))
        .sort((a, b) => b.events - a.events)
        .slice(0, 6),
      /**
       * Ações registradas por pessoa nos últimos 30 dias — movimento, não
       * acesso. Ver a nota do método.
       */
      topActors: atores.map((ator) => {
        const pessoa = pessoas.find((item) => item.id === ator.userId);
        return {
          id: ator.userId,
          name: pessoa?.fullName ?? 'Usuário removido',
          photoUrl: pessoa?.profilePhotoUrl ?? null,
          role: pessoa?.role ?? null,
          actions: ator.total,
        };
      }),
      windowDays: 30,
    };
  }
}
