import { Injectable, NotFoundException } from '@nestjs/common';
import { Log, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma';
import { ListLogsDto } from './dto/list-logs.dto';
import { buildChanges } from './log-diff';
import { actionLabel, isMainModel, modelLabel } from './log-labels';

type Person = { id: string; name: string; photoUrl: string | null };

/**
 * O snapshot sem os carimbos de tempo, que mudam em todo save e não contam
 * como alteração.
 *
 * O `CASE` existe por causa dos lotes: em jsonb, `- 'updatedAt'` tira a chave
 * de um objeto, mas num array ele tenta remover elementos e deixa os carimbos
 * de dentro intactos — com isso todo `updateMany` sem alteração passava pelo
 * filtro e chegava na tela com conteúdo vazio.
 */
function semCarimbos(coluna: 'before' | 'after'): Prisma.Sql {
  const campo = Prisma.raw(`"${coluna}"`);
  return Prisma.sql`
    CASE jsonb_typeof(${campo})
      WHEN 'array' THEN (
        SELECT jsonb_agg(item - 'updatedAt' - 'updateAt' - 'createdAt')
        FROM jsonb_array_elements(${campo}) item
      )
      ELSE ${campo} - 'updatedAt' - 'updateAt' - 'createdAt'
    END`;
}

/**
 * Chave da ação. Linha antiga sem `requestId` cai no próprio id e vira um grupo
 * de um — a migration preencheu o histórico, então isso é só rede de proteção.
 */
const GROUP_KEY = Prisma.sql`COALESCE("requestId", "id")`;

/** A coluna volta NULL no `$queryRaw` e como `[]` pelo client — normaliza os dois */
function targetsRaw(row: Log): string[] {
  return row.targetUserIds ?? [];
}

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 50;

@Injectable()
export class LogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListLogsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const where = this.buildWhere(query);

    // Pagina por ação, não por linha: uma inscrição escreve em quatro tabelas,
    // e paginar por linha cortaria a mesma ação ao meio entre duas páginas.
    const [grupos, [{ total }], summary] = await Promise.all([
      this.prisma.$queryRaw<{ grupo: string }[]>`
        SELECT ${GROUP_KEY} AS grupo, max("createdAt") AS quando
        FROM "logs" WHERE ${where}
        GROUP BY grupo
        ORDER BY quando DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      `,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM (
          SELECT ${GROUP_KEY} AS grupo FROM "logs" WHERE ${where} GROUP BY grupo
        ) g
      `,
      this.summarize(where),
    ]);

    const chaves = grupos.map((item) => item.grupo);
    const rows = chaves.length
      ? await this.prisma.$queryRaw<Log[]>`
          SELECT * FROM "logs"
          WHERE ${where} AND ${GROUP_KEY} IN (${Prisma.join(chaves)})
          ORDER BY "createdAt" ASC
        `
      : [];

    const people = await this.resolvePeople(rows);

    return {
      // a ordem dos grupos é a da consulta paginada; as linhas vêm soltas
      items: chaves.map((chave) =>
        this.toGroup(
          chave,
          rows.filter((row) => (row.requestId ?? row.id) === chave),
          people,
        ),
      ),
      total,
      page,
      limit,
      summary,
    };
  }

  async findOne(chave: string) {
    const rows = await this.prisma.$queryRaw<Log[]>`
      SELECT * FROM "logs" WHERE ${GROUP_KEY} = ${chave}
      ORDER BY "createdAt" ASC
    `;

    if (rows.length === 0) {
      throw new NotFoundException('Registro de atividade não encontrado');
    }

    return this.toGroup(chave, rows, await this.resolvePeople(rows));
  }

  /**
   * Uma ação da tela: várias escritas amarradas pelo mesmo `requestId`.
   *
   * A linha principal é a que tem mais campos alterados — numa inscrição, é a
   * inscrição em si, e não o vínculo com o grupo que veio junto. As demais
   * viram "+N tabelas" e abrem no painel lateral.
   */
  private toGroup(chave: string, rows: Log[], people: Map<string, Person>) {
    const entries = rows.map((row) => this.toItem(row, people));

    // Tabela de verdade ganha de tabela de vínculo; empatado nisso, ganha quem
    // teve mais campos alterados.
    const peso = (entry: (typeof entries)[number]) =>
      (isMainModel(entry.model) ? 1000 : 0) + entry.changes.length;

    const principal = entries.reduce((maior, atual) =>
      peso(atual) > peso(maior) ? atual : maior,
    );

    const atingidos = new Map<string, Person>();
    entries.forEach((entry) =>
      entry.targets.forEach((target) => atingidos.set(target.id, target)),
    );

    const tabelas = new Set(entries.map((entry) => entry.model));

    return {
      id: chave,
      // a mais recente do grupo: é o instante em que a ação terminou
      createdAt: rows[rows.length - 1].createdAt,
      actorName: principal.actorName,
      actorPhotoUrl: principal.actorPhotoUrl,
      targets: [...atingidos.values()],
      action: principal.action,
      actionLabel: principal.actionLabel,
      model: principal.model,
      modelLabel: principal.modelLabel,
      /** quantas tabelas a mesma ação tocou */
      tablesCount: tabelas.size,
      /** quantas escritas a ação gerou, contando repetições na mesma tabela */
      entriesCount: entries.length,
      changes: principal.changes,
      noChanges: principal.noChanges,
      /** cada escrita da ação, para o painel lateral */
      entries,
    };
  }

  /**
   * Contagem por família de ação para os cards do topo, sobre o mesmo filtro da
   * listagem. Conta escritas, e não ações agrupadas: uma inscrição cria quatro
   * registros, e é isso que o card de "criações" está dizendo.
   */
  private async summarize(where: Prisma.Sql) {
    const porAcao = await this.prisma.$queryRaw<
      { action: string; total: number }[]
    >`SELECT "action", count(*)::int AS total FROM "logs" WHERE ${where} GROUP BY "action"`;

    const soma = (acoes: string[]) =>
      porAcao
        .filter((item) => acoes.includes(item.action))
        .reduce((total, item) => total + item.total, 0);

    return {
      created: soma(['create', 'createMany']),
      updated: soma(['update', 'updateMany', 'upsert']),
      deleted: soma(['delete', 'deleteMany']),
    };
  }

  private buildWhere(query: ListLogsDto): Prisma.Sql {
    const from = query.from
      ? new Date(query.from)
      : new Date(Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);

    const conditions: Prisma.Sql[] = [Prisma.sql`"createdAt" >= ${from}`];

    if (query.to) {
      conditions.push(Prisma.sql`"createdAt" <= ${new Date(query.to)}`);
    }
    if (query.model) {
      conditions.push(Prisma.sql`"model" = ${query.model}`);
    }
    if (query.action) {
      conditions.push(Prisma.sql`"action" = ${query.action}`);
    }

    // "Envolvido": o que a pessoa fez e o que fizeram com ela, num campo só.
    // Funciona sozinho ou junto com o período — as duas condições entram na
    // mesma cláusula, então nenhuma depende da outra.
    if (query.userId) {
      conditions.push(
        Prisma.sql`("userId" = ${query.userId} OR ${query.userId} = ANY("targetUserIds"))`,
      );
    }

    // Salvar sem mexer em nada dispara `update` no Prisma e gerava linha de
    // log com conteúdo vazio. O middleware já não grava mais, mas metade dos
    // updates que estão na tabela é isso — e ninguém tem o que fazer com eles.
    // Criação e remoção passam direto: lá um dos lados é nulo mesmo.
    conditions.push(Prisma.sql`(
      "before" IS NULL
      OR "after" IS NULL
      OR ${semCarimbos('before')} IS DISTINCT FROM ${semCarimbos('after')}
    )`);

    // Linha sem snapshot dos dois lados: o middleware registrou a operação mas
    // não conseguiu capturar o registro (o `findMany` do `deleteMany` volta
    // vazio quando o `where` não casa, e o `createMany` de chave composta não
    // recupera o que criou). Sem conteúdo e sem atingido, não há o que mostrar.
    conditions.push(Prisma.sql`NOT (
      ("before" IS NULL OR "before" = '[]'::jsonb OR "before" = 'null'::jsonb)
      AND
      ("after" IS NULL OR "after" = '[]'::jsonb OR "after" = 'null'::jsonb)
    )`);

    return Prisma.join(conditions, ' AND ');
  }

  /**
   * Uma consulta para a página inteira, cobrindo quem executou e quem recebeu a
   * ação. Resolver dentro do laço daria dezenas de idas ao banco por página.
   */
  private async resolvePeople(rows: Log[]): Promise<Map<string, Person>> {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.userId) ids.add(row.userId);
      // no SQL cru a coluna volta como NULL quando o array está vazio; o
      // client do Prisma é que normaliza para lista vazia
      targetsRaw(row).forEach((id) => ids.add(id));
    }

    const people = new Map<string, Person>();
    if (ids.size === 0) return people;

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, fullName: true, profilePhotoUrl: true },
    });

    users.forEach((user) =>
      people.set(user.id, {
        id: user.id,
        name: user.fullName.trim(),
        photoUrl: user.profilePhotoUrl,
      }),
    );
    return people;
  }

  /**
   * Quem recebeu a ação, por nome.
   *
   * Cadastro apagado depois some da consulta de usuários, mas o snapshot ainda
   * guarda o nome de quem era — e é justamente na linha do "removeu" que saber
   * o nome importa mais.
   */
  private targetsOf(row: Log, people: Map<string, Person>): Person[] {
    const targets = targetsRaw(row).map(
      (id): Person =>
        people.get(id) ?? { id, name: '', photoUrl: null },
    );

    const semNome = targets.filter((target) => !target.name);
    if (semNome.length > 0) {
      const snapshot = (row.after ?? row.before) as any;
      const first = Array.isArray(snapshot) ? snapshot[0] : snapshot;
      const nomeNoSnapshot =
        row.model === 'User' ? first?.fullName : undefined;

      semNome.forEach((target) => {
        target.name =
          typeof nomeNoSnapshot === 'string'
            ? nomeNoSnapshot.trim()
            : 'Registro apagado';
      });
    }

    return targets;
  }

  private toItem(row: Log, people: Map<string, Person>) {
    const author = row.userId ? people.get(row.userId) : undefined;
    const changes = buildChanges(row.before, row.after);

    return {
      id: row.id,
      createdAt: row.createdAt,
      // sem autor são as rotas públicas (inscrição, redefinição de senha)
      actorName: author?.name ?? 'Sistema',
      actorPhotoUrl: author?.photoUrl ?? null,
      /** quem recebeu a ação; vazio quando o registro não é sobre pessoas */
      targets: this.targetsOf(row, people),
      action: row.action,
      actionLabel: actionLabel(row.action, changes.length > 0),
      model: row.model,
      modelLabel: modelLabel(row.model),
      /** conteúdo da coluna: o que mudou, campo a campo */
      changes,
      /** save que não mexeu em nada — a tela precisa dizer isso, não "alterou" */
      noChanges: changes.length === 0,
    };
  }
}
