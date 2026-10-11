import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  FinancialCategory,
  FinancialEntry,
  FinancialEntrySource,
  FinancialEntryType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PluggyService } from 'src/pluggy/pluggy.service';
import {
  categoriaCabeNoTipo,
  diaEmBrasilia,
  lancamentoDaTransacao,
} from './categorias';
import { arredondar, doDia, paraDia } from './dizimistas.service';
import {
  CreateEntryDto,
  ListEntriesQuery,
  UpdateEntryDto,
} from './dto/financeiro.dto';

/** Teto da lista de um período: um ano de igreja grande cabe com folga */
const LIMITE = 5000;

/** Primeira importação: o extrato dos últimos 90 dias */
const PRIMEIRA_JANELA_DIAS = 90;
/**
 * Importações seguintes recomeçam alguns dias antes da última: transação que
 * estava pendente na leitura anterior só aparece lançada depois, com a data
 * de quando aconteceu. O id único impede que as já importadas dupliquem.
 */
const SOBREPOSICAO_DIAS = 7;

const diasAtras = (dias: number) =>
  diaEmBrasilia(new Date(Date.now() - dias * 86_400_000).toISOString());

/** Campos que o banco define no lançamento importado: não se editam */
const TRAVADOS_NO_IMPORTADO = ['type', 'amount', 'date', 'method'] as const;

/**
 * O livro-caixa da igreja: lançamentos manuais e os importados do extrato
 * pela Pluggy. Como em `DizimistasService`, todo acesso é pela igreja da rota
 * e pelo id juntos.
 */
@Injectable()
export class LancamentosService {
  private readonly logger = new Logger(LancamentosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pluggy: PluggyService,
  ) {}

  /**
   * Os lançamentos do período com os filtros, e o resumo do período inteiro.
   * O resumo ignora tipo, categoria, origem e busca de propósito: os cards
   * dizem quanto entrou e saiu no período, não quanto há na tabela filtrada.
   */
  async listar(churchId: string, q: ListEntriesQuery) {
    const hoje = diaEmBrasilia(new Date().toISOString());
    const de = q.de ?? `${hoje.slice(0, 8)}01`;
    const ate = q.ate ?? hoje;
    if (de > ate) {
      throw new BadRequestException('O início do período é depois do fim');
    }

    const doPeriodo: Prisma.FinancialEntryWhereInput = {
      churchId,
      date: { gte: paraDia(de), lte: paraDia(ate) },
    };
    const busca = q.busca?.trim();

    const [lancamentos, porTipo, dizimos] = await Promise.all([
      this.prisma.financialEntry.findMany({
        where: {
          ...doPeriodo,
          ...(q.type ? { type: q.type } : {}),
          ...(q.category ? { category: q.category } : {}),
          ...(q.source ? { source: q.source } : {}),
          ...(busca
            ? {
                OR: [
                  { description: { contains: busca, mode: 'insensitive' } },
                  { payerName: { contains: busca, mode: 'insensitive' } },
                  {
                    user: {
                      fullName: { contains: busca, mode: 'insensitive' },
                    },
                  },
                ],
              }
            : {}),
        },
        include: { user: { select: { id: true, fullName: true } } },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        take: LIMITE,
      }),
      this.prisma.financialEntry.groupBy({
        by: ['type'],
        where: doPeriodo,
        _sum: { amount: true },
      }),
      this.prisma.financialEntry.aggregate({
        where: { ...doPeriodo, category: FinancialCategory.TITHE },
        _sum: { amount: true },
      }),
    ]);

    const soma = (tipo: FinancialEntryType) =>
      Number(porTipo.find((g) => g.type === tipo)?._sum.amount ?? 0);
    const entradas = soma(FinancialEntryType.INCOME);
    const saidas = soma(FinancialEntryType.EXPENSE);

    return {
      de,
      ate,
      resumo: {
        entradas: arredondar(entradas),
        saidas: arredondar(saidas),
        saldo: arredondar(entradas - saidas),
        dizimos: arredondar(Number(dizimos._sum.amount ?? 0)),
      },
      lancamentos: lancamentos.map(paraTela),
      /** chegou no teto: a tela avisa para encurtar o período */
      cortado: lancamentos.length === LIMITE,
    };
  }

  async criar(churchId: string, dto: CreateEntryDto, actorId?: string) {
    this.conferirCategoria(dto.category, dto.type);
    await this.conferirDizimista(churchId, dto.userId);

    const criado = await this.prisma.financialEntry.create({
      data: {
        churchId,
        type: dto.type,
        category: dto.category,
        amount: dto.amount,
        date: paraDia(dto.date),
        description: dto.description.trim(),
        method: dto.method ?? null,
        userId: dto.userId ?? null,
        source: FinancialEntrySource.MANUAL,
        createdById: actorId ?? null,
        updatedById: actorId ?? null,
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    return paraTela(criado);
  }

  /**
   * No importado do banco, valor, data, tipo e forma são o que o banco diz e
   * não mudam; categoria, descrição e dizimista sim — é para isso que o
   * financeiro abre o lançamento importado.
   */
  async atualizar(
    churchId: string,
    id: string,
    dto: UpdateEntryDto,
    actorId?: string,
  ) {
    const atual = await this.exigir(churchId, id);

    if (atual.source === FinancialEntrySource.PLUGGY) {
      const mexeu = TRAVADOS_NO_IMPORTADO.filter((campo) => {
        if (dto[campo] === undefined) return false;
        if (campo === 'amount') return Number(atual.amount) !== dto.amount;
        if (campo === 'date') return doDia(atual.date) !== dto.date;
        return atual[campo] !== dto[campo];
      });
      if (mexeu.length) {
        throw new BadRequestException(
          'Lançamento importado do banco: valor, data, tipo e forma vêm do extrato e não mudam',
        );
      }
    }

    const tipo = dto.type ?? atual.type;
    this.conferirCategoria(dto.category ?? atual.category, tipo);
    if (dto.userId) await this.conferirDizimista(churchId, dto.userId);

    const salvo = await this.prisma.financialEntry.update({
      where: { id },
      data: {
        ...(atual.source === FinancialEntrySource.MANUAL
          ? {
              ...(dto.type ? { type: dto.type } : {}),
              ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
              ...(dto.date ? { date: paraDia(dto.date) } : {}),
              ...(dto.method !== undefined ? { method: dto.method } : {}),
            }
          : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() }
          : {}),
        ...(dto.userId !== undefined ? { userId: dto.userId } : {}),
        updatedById: actorId ?? null,
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    return paraTela(salvo);
  }

  /**
   * Só o manual. O importado voltaria na próxima importação — o id dele no
   * banco é o que impede a duplicata, e apagar a linha apagaria essa trava.
   */
  async remover(churchId: string, id: string) {
    const atual = await this.exigir(churchId, id);
    if (atual.source === FinancialEntrySource.PLUGGY) {
      throw new BadRequestException(
        'Lançamento importado do banco não pode ser apagado: ajuste a categoria ou a descrição',
      );
    }
    await this.prisma.financialEntry.delete({ where: { id } });
  }

  /**
   * Traz o extrato dos bancos da Pluggy como lançamentos. Da última leitura
   * (menos uma folga) até hoje; na primeira, os últimos 90 dias. Pode rodar
   * quantas vezes quiser: transação já importada não duplica (`externalId`
   * único por igreja, `skipDuplicates`).
   */
  async importar(churchId: string, actorId?: string) {
    const integracao = await this.prisma.pluggyIntegration.findUnique({
      where: { churchId },
      select: { lastSyncAt: true },
    });
    if (!integracao) {
      throw new NotFoundException(
        'A Pluggy não está configurada nesta igreja. Configure em Configurações › Integrações.',
      );
    }

    const ate = diaEmBrasilia(new Date().toISOString());
    const de = integracao.lastSyncAt
      ? diaEmBrasilia(
          new Date(
            integracao.lastSyncAt.getTime() - SOBREPOSICAO_DIAS * 86_400_000,
          ).toISOString(),
        )
      : diasAtras(PRIMEIRA_JANELA_DIAS);

    let transacoes;
    try {
      transacoes = await this.pluggy.transacoes(churchId, de, ate);
    } catch (erro) {
      if (erro instanceof HttpException) throw erro;
      this.logger.warn(
        `Extrato da Pluggy falhou na igreja ${churchId}: ${
          (erro as any)?.response?.status ?? (erro as Error)?.message
        }`,
      );
      throw new BadGatewayException(
        'Não foi possível ler o extrato na Pluggy agora. Tente de novo em alguns minutos.',
      );
    }

    // os dizimistas são os membros: o CPF do Pix casa com qualquer um deles
    const membros = await this.prisma.user.findMany({
      where: { memberChurchId: churchId },
      select: { id: true, cpf: true, titheAmount: true },
    });
    const porCpf = new Map(
      membros.map((m) => [
        m.cpf.replace(/\D/g, ''),
        {
          userId: m.id,
          valor: m.titheAmount === null ? null : Number(m.titheAmount),
        },
      ]),
    );

    const { count } = await this.prisma.financialEntry.createMany({
      data: transacoes.map((t) => ({
        churchId,
        source: FinancialEntrySource.PLUGGY,
        createdById: actorId ?? null,
        updatedById: actorId ?? null,
        ...lancamentoDaTransacao(t, porCpf),
      })),
      skipDuplicates: true,
    });

    await this.pluggy.marcarLeitura(churchId);

    return {
      de,
      ate,
      lidas: transacoes.length,
      importadas: count,
      jaExistiam: transacoes.length - count,
    };
  }

  // ----------------------------------------------------------------------

  private conferirCategoria(
    categoria: FinancialCategory,
    tipo: FinancialEntryType,
  ) {
    if (!categoriaCabeNoTipo(categoria, tipo)) {
      throw new BadRequestException(
        tipo === FinancialEntryType.INCOME
          ? 'Esta categoria é de saída, e o lançamento é uma entrada'
          : 'Esta categoria é de entrada, e o lançamento é uma saída',
      );
    }
  }

  /** O dizimista do lançamento precisa ser membro desta igreja */
  private async conferirDizimista(churchId: string, userId?: string | null) {
    if (!userId) return;
    const membro = await this.prisma.user.findFirst({
      where: { id: userId, memberChurchId: churchId },
      select: { id: true },
    });
    if (!membro) {
      throw new BadRequestException('Esta pessoa não é membro desta igreja');
    }
  }

  private async exigir(churchId: string, id: string) {
    const lancamento = await this.prisma.financialEntry.findFirst({
      where: { id, churchId },
    });
    if (!lancamento) throw new NotFoundException('Lançamento não encontrado');
    return lancamento;
  }
}

/** Valor como número e data como "2026-10-03", que é o que a tela usa */
function paraTela(
  l: FinancialEntry & { user: { id: string; fullName: string } | null },
) {
  return {
    id: l.id,
    type: l.type,
    category: l.category,
    amount: Number(l.amount),
    date: doDia(l.date),
    description: l.description,
    method: l.method,
    source: l.source,
    bankAccount: l.bankAccount,
    payerName: l.payerName,
    user: l.user,
    createdAt: l.createdAt,
  };
}
