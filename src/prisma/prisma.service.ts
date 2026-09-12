import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { OrigemDaEscrita, requestContext } from 'src/context/request.context';
import { randomUUID } from 'crypto';

/**
 * Campos que não podem entrar no log. A tela de atividades mostra o antes e o
 * depois para o super admin, e hash de senha e os hashes do fluxo de
 * redefinição não têm por que passar por ali — nem ficar guardados numa
 * segunda tabela.
 */
const REDACTED_FIELDS: Record<string, string[]> = {
  User: ['password'],
  UserToken: ['codeHash', 'ticketHash'],
  /**
   * A credencial de cobrança fica cifrada no banco justamente para não estar
   * ao alcance de quem lê a tabela. Sem esta linha, o envelope inteiro seria
   * copiado para `logs.before`/`logs.after` a cada salvar — e a tela de
   * atividades, que o super admin abre, passaria a ser a cópia em claro do
   * cofre que ninguém deveria abrir por ali.
   *
   * O hash do segredo do webhook sai junto: com ele em mãos dá para procurar
   * a configuração correspondente e confirmar um segredo adivinhado.
   */
  PaymentProviderConfig: ['credentials', 'webhookSecretHash'],
};

/** Marca no lugar do segredo: registra que mudou, sem guardar o valor */
const CHANGED_MARKER = '(alterada)';

/**
 * Tira o material de credencial do log sem perder o fato de que ele mudou.
 *
 * Só apagar o campo escondia a troca de senha por completo: os dois lados
 * ficavam iguais e a linha era descartada como "nada mudou" — justo o evento
 * que mais interessa auditar.
 */
function redactPair(model: string, before: any, after: any) {
  const fields = REDACTED_FIELDS[model];
  if (!fields) return { before, after };

  const first = (snapshot: any) =>
    Array.isArray(snapshot) ? snapshot[0] : snapshot;

  const antes = first(before);
  const depois = first(after);

  const alterados: Record<string, string> = {};
  if (antes && depois) {
    for (const field of fields) {
      if (depois[field] !== undefined && antes[field] !== depois[field]) {
        alterados[field] = CHANGED_MARKER;
      }
    }
  }

  const limpo = redactSnapshot(model, after);
  const marcado =
    Object.keys(alterados).length > 0 && limpo && !Array.isArray(limpo)
      ? { ...limpo, ...alterados }
      : limpo;

  return { before: redactSnapshot(model, before), after: marcado };
}

function redactSnapshot(model: string, snapshot: any): any {
  const fields = REDACTED_FIELDS[model];
  if (!snapshot || !fields) return snapshot;

  const clean = (row: any) => {
    if (!row || typeof row !== 'object') return row;
    const copy = { ...row };
    for (const field of fields) delete copy[field];
    return copy;
  };

  return Array.isArray(snapshot) ? snapshot.map(clean) : clean(snapshot);
}

/** Carimbos de tempo mudam em todo save e não contam como alteração */
const TIMESTAMP_FIELDS = ['updatedAt', 'updateAt', 'createdAt'];

function withoutTimestamps(row: any) {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  for (const field of TIMESTAMP_FIELDS) delete copy[field];
  return copy;
}

/**
 * Salvar um formulário sem mexer em nada dispara `update` do mesmo jeito, e o
 * log resultante dizia "alterou" com conteúdo vazio — metade dos updates da
 * tabela era isso. O registro não some da tela: ele deixa de nascer.
 */
function nothingChanged(before: any, after: any): boolean {
  if (!before || !after) return false;

  const normalize = (snapshot: any) =>
    JSON.stringify(
      Array.isArray(snapshot)
        ? snapshot.map(withoutTimestamps)
        : withoutTimestamps(snapshot),
    );

  return normalize(before) === normalize(after);
}

/**
 * As tabelas do dinheiro.
 *
 * `Discounts` entra junto com as duas de pagamento: mexer no percentual muda o
 * que cada pessoa deve, mesmo sem tocar em cobrança nenhuma.
 */
const FINANCE_MODELS = new Set(['Payment', 'PaymentCheckout', 'Discounts']);

/** Carimbo de tempo muda em todo save e não é notícia financeira */
const FINANCE_NOISE = new Set(['createdAt', 'updatedAt', 'updateAt']);

/**
 * Campos grandes demais para copiar linha a linha. O retorno do PagBank tem
 * quilobytes de JSON, e o que interessa ao financeiro é que ele mudou.
 */
const BULKY_FIELDS = new Set(['payload']);

/** Marca no lugar do conteúdo volumoso */
const BULKY_MARKER = '(atualizado)';

/**
 * O que mudou numa cobrança, campo a campo.
 *
 * Guarda só a diferença, e não os dois retratos inteiros como faz `Log`: a
 * pergunta aqui é "o que aconteceu com este dinheiro", e a resposta cabe em
 * três ou quatro campos.
 */
function financeChanges(before: any, after: any) {
  const campos = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);

  const diff: Record<string, Prisma.InputJsonValue> = {};

  for (const campo of campos) {
    if (FINANCE_NOISE.has(campo)) continue;

    const antes = before?.[campo] ?? null;
    const depois = after?.[campo] ?? null;

    if (JSON.stringify(antes) === JSON.stringify(depois)) continue;

    diff[campo] = BULKY_FIELDS.has(campo)
      ? {
          before: antes === null ? null : BULKY_MARKER,
          after: depois === null ? null : BULKY_MARKER,
        }
      : { before: antes, after: depois };
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

/** Um retrato vira lista: operação em lote grava array, a simples grava objeto */
function comoLista(snapshot: any): any[] {
  if (snapshot === null || snapshot === undefined) return [];
  return Array.isArray(snapshot) ? snapshot : [snapshot];
}

/**
 * Casa o antes com o depois registro a registro, pelo id.
 *
 * É o que faz um `updateMany` de doze cobranças virar doze linhas de log em
 * vez de uma: "o que aconteceu com a minha" é a pergunta que se faz aqui, e
 * uma linha por comando não a responde.
 */
function parearPorId(before: any, after: any) {
  const pares = new Map<string, { antes?: any; depois?: any }>();

  comoLista(before).forEach((row, indice) => {
    const chave = row?.id ?? `#${indice}`;
    pares.set(chave, { ...pares.get(chave), antes: row });
  });

  comoLista(after).forEach((row, indice) => {
    const chave = row?.id ?? `#${indice}`;
    pares.set(chave, { ...pares.get(chave), depois: row });
  });

  return [...pares.values()];
}

/**
 * O "depois" de um `updateMany`, calculado em vez de relido.
 *
 * Dentro de uma transação interativa a releitura roda **por fora** dela e
 * devolve o estado antigo: o log conclui que nada mudou e a escrita some da
 * auditoria sem deixar rastro. O `updateMany` com campos de valor simples é
 * previsível — é o "antes" com esses campos por cima —, então aqui a conta é
 * exata.
 *
 * Devolve nulo quando o pedido traz operador (`{ increment: 1 }` e afins): aí
 * o resultado depende do banco e chutá-lo seria gravar um "depois" inventado.
 */
function applyUpdateData(before: any, data: any): any[] | null {
  if (!Array.isArray(before) || !data || typeof data !== 'object') return null;

  const simples = Object.values(data).every(
    (valor) =>
      valor === null || valor instanceof Date || typeof valor !== 'object',
  );
  if (!simples) return null;

  return before.map((row) => ({ ...row, ...data }));
}

/**
 * Quem a ação atingiu, para o filtro por usuário da tela de atividades. No
 * model `User` o alvo é o próprio registro; nos demais é o `userId` do
 * snapshot. Operações em lote gravam array, e aí cada item conta.
 */
export function extractTargetUserIds(
  model: string,
  entityId: string | null,
  before: any,
  after: any,
): string[] {
  const ids = new Set<string>();

  if (model === 'User' && entityId) {
    ids.add(entityId);
  }

  for (const snapshot of [before, after]) {
    if (!snapshot) continue;
    const rows = Array.isArray(snapshot) ? snapshot : [snapshot];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = model === 'User' ? row.id : row.userId;
      if (typeof id === 'string') ids.add(id);
    }
  }

  return [...ids];
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();

    this.$use(async (params, next) => {
      // `WhatsappAuth` fica de fora junto com `Log`: são as chaves do Signal,
      // reescritas a cada mensagem trocada. Auditar isso encheria a tabela de
      // log e, pior, copiaria material criptográfico para dentro dela.
      //
      // `LoginAttempt` sai pelo mesmo motivo do volume: ela **é** um registro,
      // uma linha por tentativa de entrada. Auditar o registro geraria uma
      // linha de log por login — e o log de auditoria existe para contar o que
      // as pessoas mudam, não quantas vezes elas entram.
      //
      // `PaymentLog` sai porque é log também: auditar a trilha do dinheiro
      // geraria uma linha genérica por linha financeira, em dobro.
      if (
        params.model === 'Log' ||
        params.model === 'PaymentLog' ||
        params.model === 'WhatsappAuth' ||
        params.model === 'LoginAttempt'
      ) {
        return next(params);
      }

      const actionsToLog = [
        'create',
        'update',
        'delete',
        'createMany',
        'updateMany',
        'deleteMany',
        'upsert',
      ];

      if (!actionsToLog.includes(params.action)) {
        return next(params);
      }

      const model = params.model;
      const delegate = (this as any)[
        model.charAt(0).toLowerCase() + model.slice(1)
      ];

      const store = requestContext.getStore();
      const userId = store?.userId ?? null;
      const requestId = store?.requestId ?? null;
      const operation = store?.operation ?? null;

      let before: any = null;
      let after: any = null;
      let entityId: string | null = null;

      const createdWheres: any[] = [];

      // ==========================
      // 1. BEFORE
      // ==========================
      if (['update', 'delete'].includes(params.action)) {
        before = await delegate.findUnique({
          where: params.args.where,
        });
      }

      if (['updateMany', 'deleteMany'].includes(params.action)) {
        before = await delegate.findMany({
          where: params.args.where,
        });
      }

      // ==========================
      // 2. CREATE MANY → tratar id simples ou composto
      // ==========================
      if (params.action === 'createMany' && Array.isArray(params.args.data)) {
        params.args.data = params.args.data.map((item: any) => {
          // Se tiver id simples
          if ('id' in item) {
            const id = item.id ?? randomUUID();
            createdWheres.push({ id });
            return { ...item, id };
          }

          // Caso NÃO tenha id (chave composta)
          // Usa todos os campos enviados como identificador
          createdWheres.push({ ...item });

          return item;
        });
      }

      // ==========================
      // 3. EXECUTA
      // ==========================
      let result;
      try {
        result = await next(params);
      } catch (err: any) {
        this.logger.error(`Erro em ${model}.${params.action}: ${err.message}`);
        throw err;
      }

      // ==========================
      // 4. AFTER
      // ==========================

      if (params.action === 'create') {
        after = result;
        entityId = result?.id ?? JSON.stringify(params.args.data);
      }

      if (params.action === 'update') {
        // o próprio resultado, e não uma releitura: dentro de uma transação
        // interativa a releitura roda por fora e devolve o estado anterior —
        // o log dava "nada mudou" e a alteração sumia da auditoria. De quebra
        // é uma consulta a menos por escrita.
        after = result;
        entityId = after?.id ?? JSON.stringify(params.args.where);
      }

      if (params.action === 'delete') {
        after = null;
        entityId = before?.id ?? JSON.stringify(params.args.where);
      }

      if (params.action === 'createMany') {
        if (params.runInTransaction) {
          // a releitura de fora da transação não enxerga o que acabou de ser
          // criado e devolvia lista vazia; o próprio pedido já traz os campos
          // gravados, com os ids que o passo 2 injetou
          after = params.args.data;
        } else if (createdWheres.length > 0) {
          after = await delegate.findMany({
            where: {
              OR: createdWheres,
            },
          });
        }

        entityId = after?.[0]?.id ?? JSON.stringify(createdWheres[0] ?? null);
      }

      if (params.action === 'updateMany') {
        const ids = before?.map((r: any) => r.id).filter(Boolean) ?? [];

        const calculado = params.runInTransaction
          ? applyUpdateData(before, params.args.data)
          : null;

        if (calculado) {
          after = calculado;
        } else if (ids.length > 0) {
          after = await delegate.findMany({
            where: { id: { in: ids } },
          });
        }

        entityId = ids[0] ?? JSON.stringify(params.args.where);
      }

      if (params.action === 'deleteMany') {
        after = null;
        entityId = before?.[0]?.id ?? JSON.stringify(params.args.where);
      }

      if (params.action === 'upsert') {
        after = result;
        entityId = result?.id ?? JSON.stringify(params.args.where);
      }

      // ==========================
      // 5. LOG
      // ==========================
      if (nothingChanged(before, after)) {
        return result;
      }

      const redigido = redactPair(model, before, after);

      await this.log.create({
        data: {
          model,
          action: params.action,
          entityId,
          before: redigido.before ?? undefined,
          after: redigido.after ?? undefined,
          userId,
          requestId,
          operation,
          targetUserIds: extractTargetUserIds(model, entityId, before, after),
        },
      });

      this.logger.log(
        `[LOG] ${model}.${params.action} user=${
          userId ?? 'anon'
        } entity=${entityId}`,
      );

      if (FINANCE_MODELS.has(model)) {
        await this.registrarNoFinanceiro({
          model,
          action: params.action,
          before,
          after,
          userId,
          operation,
          requestId,
          source: store?.source ?? 'SYSTEM',
        });
      }

      return result;
    });
  }

  /**
   * Grava a trilha do dinheiro: uma linha por cobrança afetada.
   *
   * Roda ao lado da auditoria genérica e não no lugar dela — `Log` continua
   * guardando o retrato inteiro para quem investiga o sistema. Aqui a linha é
   * do financeiro: valor, status e de onde veio a mudança, consultáveis por
   * evento e por pessoa sem abrir JSON.
   *
   * Nunca derruba a operação: um erro ao registrar a trilha não pode desfazer
   * um pagamento que já entrou. Vira aviso no log da aplicação.
   */
  private async registrarNoFinanceiro(dados: {
    model: string;
    action: string;
    before: any;
    after: any;
    userId: string | null;
    operation: string | null;
    requestId: string | null;
    source: OrigemDaEscrita;
  }) {
    try {
      const pares = parearPorId(dados.before, dados.after);
      if (pares.length === 0) return;

      const linhas: Prisma.PaymentLogCreateManyInput[] = pares.map(
        ({ antes, depois }) => {
          // o registro pelo lado que existir: numa remoção só há o "antes"
          const alvo = depois ?? antes;

          return {
            paymentId:
              dados.model === 'Payment'
                ? alvo?.id ?? null
                : dados.model === 'PaymentCheckout'
                ? alvo?.paymentId ?? null
                : null,
            userId: dados.model === 'Payment' ? alvo?.userId ?? null : null,
            eventId: dados.model === 'Payment' ? alvo?.eventId ?? null : null,
            model: dados.model,
            action: dados.action,
            entityId: alvo?.id ?? null,
            amountBefore: antes?.amount ?? null,
            amountAfter: depois?.amount ?? null,
            statusBefore: antes?.status ?? null,
            statusAfter: depois?.status ?? null,
            source: dados.source,
            actorId: dados.userId,
            operation: dados.operation,
            requestId: dados.requestId,
            changes: financeChanges(antes, depois) ?? Prisma.DbNull,
          };
        },
      );

      await this.completarDonoDaCobranca(linhas);

      await this.paymentLog.createMany({ data: linhas });
    } catch (erro: any) {
      this.logger.warn(
        `Não foi possível registrar a trilha financeira de ${dados.model}.${dados.action}: ${erro?.message}`,
      );
    }
  }

  /**
   * Preenche quem deve e por qual evento nas linhas de checkout.
   *
   * O checkout só conhece a cobrança; quem consulta o log procura pelo evento.
   * Uma consulta para o lote inteiro, e não uma por linha — a reconciliação
   * mexe em dezenas de checkouts por rodada.
   */
  private async completarDonoDaCobranca(
    linhas: Prisma.PaymentLogCreateManyInput[],
  ) {
    const pendentes = linhas.flatMap((linha) =>
      linha.paymentId && !linha.userId && !linha.eventId
        ? [{ linha, paymentId: linha.paymentId }]
        : [],
    );
    if (pendentes.length === 0) return;

    const cobrancas = await this.payment.findMany({
      where: { id: { in: [...new Set(pendentes.map((p) => p.paymentId))] } },
      select: { id: true, userId: true, eventId: true },
    });

    const porId = new Map(cobrancas.map((c) => [c.id, c]));

    pendentes.forEach(({ linha, paymentId }) => {
      const dona = porId.get(paymentId);
      if (!dona) return;
      linha.userId = dona.userId;
      linha.eventId = dona.eventId;
    });
  }

  async enableShutdownHooks(app: INestApplication) {
    this.$on('beforeExit', async () => {
      await app.close();
    });
  }
}
