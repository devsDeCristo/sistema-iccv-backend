import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FinancialEntrySource } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { diaEmBrasilia } from './categorias';
import { sugerirPares } from './conciliacao';
import { arredondar, paraDia } from './dizimistas.service';
import { DA_ADMINISTRATIVA, PARA_TELA, paraTela } from './lancamentos.service';

type Lancamento = ReturnType<typeof paraTela>;

/**
 * Como uma linha do diff está: o par já feito, o sugerido, só um lado, ou o
 * manual que a pessoa confirmou que não consta no banco
 */
export type EstadoDaLinha =
  | 'conciliado'
  | 'sugerido'
  | 'so_banco'
  | 'so_manual'
  | 'nao_consta';

export interface LinhaDaConciliacao {
  estado: EstadoDaLinha;
  banco: Lancamento | null;
  manual: Lancamento | null;
}

const ORDEM: Record<EstadoDaLinha, number> = {
  sugerido: 0,
  so_banco: 1,
  so_manual: 2,
  nao_consta: 3,
  conciliado: 4,
};

/**
 * Conciliação do livro-caixa: o que veio do banco (Pluggy) contra o que foi
 * lançado à mão. O par conciliado é o mesmo dinheiro registrado duas vezes —
 * o manual aponta para o do banco (`reconciledWithId`), conta uma vez nos
 * totais (vale o do banco) e o do banco herda a categoria e o dizimista que a
 * pessoa deu no manual.
 *
 * Como nos outros services da tesouraria, tudo é pela igreja da rota: os dois
 * lados do par precisam ser dela.
 */
@Injectable()
export class ConciliacaoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * As linhas do diff do período: os pares conciliados, os sugeridos e o que
   * sobrou de cada lado. Um par já feito aparece se qualquer ponta cai no
   * período — o Pix do dia 31 pode ter sido lançado no dia 1º.
   */
  async listar(churchId: string, de?: string, ate?: string) {
    const periodo = this.periodo(de, ate);

    const doPeriodo = await this.prisma.financialEntry.findMany({
      where: {
        churchId,
        // só a conta da Administrativa; e o que já foi distribuído para um
        // evento ou congregação (sem a divisão dos bancos) é de lá
        ...DA_ADMINISTRATIVA,
        allocations: { none: {} },
        date: { gte: paraDia(periodo.de), lte: paraDia(periodo.ate) },
      },
      include: PARA_TELA,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    // a outra ponta dos pares que caiu fora do período
    const ids = new Set(doPeriodo.map((l) => l.id));
    const faltam = doPeriodo
      .map((l) => l.reconciledWithId ?? l.reconciledBy?.id)
      .filter((id): id is string => !!id && !ids.has(id));
    const deFora = faltam.length
      ? await this.prisma.financialEntry.findMany({
          where: { churchId, id: { in: faltam } },
          include: PARA_TELA,
        })
      : [];

    const porId = new Map(
      [...doPeriodo, ...deFora].map((l) => [l.id, paraTela(l)]),
    );
    const todos = [...porId.values()];
    const banco = todos.filter((l) => l.source === FinancialEntrySource.PLUGGY);
    const manuais = todos.filter(
      (l) => l.source === FinancialEntrySource.MANUAL,
    );

    const linhas: LinhaDaConciliacao[] = [];
    for (const m of manuais) {
      if (m.conciliadoCom) {
        linhas.push({
          estado: 'conciliado',
          banco: porId.get(m.conciliadoCom) ?? null,
          manual: m,
        });
      }
    }

    const bancoPendente = banco.filter((b) => !b.conciliado);
    // o que não consta no banco não entra na sugestão: já foi resolvido
    const manualPendente = manuais.filter(
      (m) => !m.conciliado && !m.naoConstaNoBanco,
    );
    const sugeridos = sugerirPares(
      bancoPendente.map(paraSugestao),
      manualPendente.map(paraSugestao),
    );
    const sugeridosIds = new Set(
      sugeridos.flatMap((p) => [p.bancoId, p.manualId]),
    );
    for (const par of sugeridos) {
      linhas.push({
        estado: 'sugerido',
        banco: porId.get(par.bancoId) ?? null,
        manual: porId.get(par.manualId) ?? null,
      });
    }
    for (const b of bancoPendente) {
      if (!sugeridosIds.has(b.id)) {
        linhas.push({ estado: 'so_banco', banco: b, manual: null });
      }
    }
    for (const m of manualPendente) {
      if (!sugeridosIds.has(m.id)) {
        linhas.push({ estado: 'so_manual', banco: null, manual: m });
      }
    }
    for (const m of manuais) {
      if (!m.conciliado && m.naoConstaNoBanco) {
        linhas.push({ estado: 'nao_consta', banco: null, manual: m });
      }
    }

    // o que pede ação primeiro; dentro de cada grupo, do mais recente
    const dataDa = (l: LinhaDaConciliacao) =>
      (l.banco?.date ?? l.manual?.date) as string;
    linhas.sort(
      (a, b) =>
        ORDEM[a.estado] - ORDEM[b.estado] || dataDa(b).localeCompare(dataDa(a)),
    );

    const soma = (lista: Lancamento[]) =>
      arredondar(
        lista.reduce(
          (total, l) => total + (l.type === 'INCOME' ? l.amount : -l.amount),
          0,
        ),
      );
    const contar = (estado: EstadoDaLinha) =>
      linhas.filter((l) => l.estado === estado).length;

    return {
      ...periodo,
      resumo: {
        conciliados: contar('conciliado'),
        sugeridos: contar('sugerido'),
        soBanco: contar('so_banco'),
        soManual: contar('so_manual'),
        naoConsta: contar('nao_consta'),
        /** saldo (entradas − saídas) do que está pendente de cada lado */
        valorSoBanco: soma(
          bancoPendente.filter((b) => !sugeridosIds.has(b.id)),
        ),
        valorSoManual: soma(
          manualPendente.filter((m) => !sugeridosIds.has(m.id)),
        ),
      },
      linhas,
    };
  }

  /**
   * Concilia um par. O banco herda a categoria e o dizimista do manual — é a
   * classificação que a pessoa deu —, e valor, data e forma continuam os do
   * extrato.
   */
  async conciliar(
    churchId: string,
    bancoId: string,
    manualId: string,
    actorId?: string,
  ) {
    const [banco, manual] = await Promise.all([
      this.prisma.financialEntry.findFirst({
        where: { id: bancoId, churchId },
        include: { reconciledBy: { select: { id: true } } },
      }),
      this.prisma.financialEntry.findFirst({
        where: { id: manualId, churchId },
      }),
    ]);
    if (!banco || !manual) {
      throw new NotFoundException('Lançamento não encontrado');
    }
    if (banco.source !== FinancialEntrySource.PLUGGY) {
      throw new BadRequestException(
        'O lado do banco precisa ser um lançamento importado do extrato',
      );
    }
    if (manual.source !== FinancialEntrySource.MANUAL) {
      throw new BadRequestException(
        'O outro lado precisa ser um lançamento manual',
      );
    }
    if (banco.type !== manual.type) {
      throw new BadRequestException(
        'Entrada só concilia com entrada, e saída com saída',
      );
    }
    if (banco.reconciledBy || manual.reconciledWithId) {
      throw new ConflictException('Um dos dois já está conciliado');
    }

    try {
      await this.prisma.financialEntry.update({
        where: { id: manual.id },
        data: {
          reconciledWithId: banco.id,
          reconciledAt: new Date(),
          reconciledById: actorId ?? null,
          // o banco mostrou que constava: a marca não vale mais
          notInBankAt: null,
          notInBankById: null,
        },
      });
    } catch (erro) {
      // outra pessoa conciliou a mesma transação entre a leitura e a escrita
      if ((erro as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          'Esta transação do banco já foi conciliada',
        );
      }
      throw erro;
    }

    await this.prisma.financialEntry.update({
      where: { id: banco.id },
      data: {
        category: manual.category,
        userId: manual.userId ?? banco.userId,
        updatedById: actorId ?? null,
      },
    });
  }

  /** Concilia de uma vez todos os pares sugeridos do período */
  async conciliarSugeridos(
    churchId: string,
    de?: string,
    ate?: string,
    actorId?: string,
  ) {
    const { linhas } = await this.listar(churchId, de, ate);
    let conciliados = 0;
    for (const linha of linhas) {
      if (linha.estado !== 'sugerido' || !linha.banco || !linha.manual) {
        continue;
      }
      await this.conciliar(churchId, linha.banco.id, linha.manual.id, actorId);
      conciliados++;
    }
    return { conciliados };
  }

  /**
   * Desfaz o par: o manual volta a contar nos totais. A categoria que o banco
   * herdou fica — é a classificação que a pessoa deu, e continua valendo.
   */
  async desfazer(churchId: string, manualId: string) {
    const manual = await this.prisma.financialEntry.findFirst({
      where: { id: manualId, churchId, reconciledWithId: { not: null } },
      select: { id: true },
    });
    if (!manual) throw new NotFoundException('Conciliação não encontrada');
    await this.prisma.financialEntry.update({
      where: { id: manualId },
      data: {
        reconciledWithId: null,
        reconciledAt: null,
        reconciledById: null,
      },
    });
  }

  /**
   * O manual que não vai aparecer no extrato — dinheiro em espécie — sai da
   * fila da conciliação como "não consta no banco". Continua contando nos
   * totais, como todo manual sem par; desmarcar o devolve para a fila.
   */
  async marcarNaoConsta(
    churchId: string,
    manualId: string,
    naoConsta: boolean,
    actorId?: string,
  ) {
    const manual = await this.prisma.financialEntry.findFirst({
      where: { id: manualId, churchId },
      select: { source: true, reconciledWithId: true },
    });
    if (!manual) throw new NotFoundException('Lançamento não encontrado');
    if (manual.source !== FinancialEntrySource.MANUAL) {
      throw new BadRequestException(
        'Só o lançamento manual pode não constar no banco',
      );
    }
    if (manual.reconciledWithId) {
      throw new ConflictException(
        'Este lançamento está conciliado: desfaça a conciliação antes',
      );
    }
    await this.prisma.financialEntry.update({
      where: { id: manualId },
      data: naoConsta
        ? { notInBankAt: new Date(), notInBankById: actorId ?? null }
        : { notInBankAt: null, notInBankById: null },
    });
  }

  private periodo(de?: string, ate?: string) {
    const hoje = diaEmBrasilia(new Date().toISOString());
    const inicio = de ?? `${hoje.slice(0, 8)}01`;
    const fim = ate ?? hoje;
    if (inicio > fim) {
      throw new BadRequestException('O início do período é depois do fim');
    }
    return { de: inicio, ate: fim };
  }
}

function paraSugestao(l: Lancamento) {
  return {
    id: l.id,
    type: l.type,
    amount: l.amount,
    date: l.date as string,
    userId: l.user?.id ?? null,
  };
}
