import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EventTreasurerKind,
  FinancialEntrySource,
  FinancialEntryType,
  PaymentReceived,
  PaymentStatus,
  Prisma,
  TreasuryAccount,
  TreasuryKind,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { churchIdsComPerfil, isSuperAdmin } from 'src/auth/tenant';
import { contaDoBanco } from 'src/pluggy/pluggy.service';
import { diaEmBrasilia } from './categorias';
import { sugerirPares } from './conciliacao';
import { doDia, paraDia } from './dizimistas.service';
import {
  CONTA_DO_TIPO,
  CONTA_NA_TELA,
  FORMA_DO_MANUAL,
  FORMA_DO_PAGAMENTO,
  SEM_CATEGORIA,
  bancoDe,
  categoriaValida,
  centavos,
  comSinal,
  idDoManual,
  idDoPagamento,
  periodoDe,
  reais,
  separarIds,
} from './tesourarias';
import {
  CriarTesourariaDto,
  LancamentoDaTesourariaDto,
} from './dto/tesourarias.dto';

/** Quem pede: o que os guards deixaram em `request.user` */
export interface Solicitante {
  userId: string;
  role?: number | null;
  churchRoles?: { churchId: string; role: number }[] | null;
}

/**
 * O "a distribuir" olha um ano para trás: a conta de uma igreja acumula
 * milhares de movimentos, e o que ninguém alocou num ano não é mais do evento.
 *
 * ponytail: janela fixa; se precisar ir além, um filtro de período na tela.
 */
const JANELA_DIAS = 365;

const SELECT_MOVIMENTO = {
  id: true,
  type: true,
  amount: true,
  date: true,
  description: true,
  payerName: true,
  bankAccount: true,
  account: true,
} as const;

type MovimentoNoBanco = Prisma.FinancialEntryGetPayload<{
  select: typeof SELECT_MOVIMENTO;
}>;

const movimentoNaTela = (m: MovimentoNoBanco) => ({
  id: m.id,
  conta: CONTA_NA_TELA[m.account],
  banco: bancoDe(m.bankAccount),
  tipo: m.type,
  descricao: m.description,
  pagador: m.payerName,
  valor: Number(m.amount),
  data: doDia(m.date) as string,
  codigo: null as string | null,
});

export type Movimento = ReturnType<typeof movimentoNaTela>;
export type Situacao = 'CONCILIADO' | 'A_CONCILIAR' | 'NAO_CONSTA';

export interface LancamentoDoSistema {
  id: string;
  tesourariaId: string;
  origem: 'INSCRICAO' | 'PRODUTO' | 'MANUAL';
  tipo: FinancialEntryType;
  categoria: string;
  descricao: string;
  valor: number;
  data: string;
  forma: string | null;
  codigo: string | null;
}

export interface LinhaDoSistema {
  lancamento: LancamentoDoSistema;
  situacao: Situacao;
  movimentoId: string | null;
}

export interface Alocacao {
  id: string;
  movimentoId: string;
  tesourariaId: string;
  valor: number;
  categoria: string | null;
}

/** O lado direito do diff: um lançamento do sistema, ou o movimento trazido */
export type LadoDaTesouraria =
  | {
      de: 'sistema';
      situacao: Situacao;
      lancamento: LancamentoDoSistema;
      automatica: boolean;
    }
  | { de: 'extrato'; alocacao: Alocacao };

/** Uma linha do diff da conciliação, como a tela desenha */
export interface LinhaDaConciliacao {
  chave: string;
  estado: 'sugerido' | 'so_banco' | 'so_evento' | 'nao_consta' | 'conciliado';
  banco: { movimento: Movimento; valor: number } | null;
  continua: boolean;
  tesouraria: LadoDaTesouraria | null;
}

/**
 * As tesourarias de evento e de congregação: o extrato da conta delas
 * distribuído entre elas, e — no evento — os pagamentos e os lançamentos
 * manuais conciliados com esse extrato.
 *
 * - **A conta:** com os bancos divididos (Pluggy), a de Eventos ou a de
 *   Congregações; sem a divisão, a da Administrativa (o que vai para um
 *   evento sai dos totais de lá).
 * - **Quem:** a equipe da igreja (admin e tesouraria; dev e super admin) vê
 *   todas, cria, fecha e reabre. O tesoureiro(a) **completo** de um evento vê
 *   e mexe só na tesouraria desse evento, e não fecha.
 * - **Fechada:** nada mais entra, sai ou muda; só reabrir.
 */
@Injectable()
export class TesourariasService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- tesourarias ---------------------------------------------------------

  async listar(churchId: string, kind: TreasuryKind, quem: Solicitante) {
    const daEquipe = this.daEquipe(churchId, quem);
    const meusEventos = daEquipe
      ? null
      : await this.eventosDoTesoureiro(quem.userId, churchId);

    const tesourarias = await this.prisma.treasury.findMany({
      where: {
        churchId,
        kind,
        ...(meusEventos ? { eventId: { in: meusEventos } } : {}),
      },
      include: {
        event: { select: { name: true, startDate: true, endDate: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const dados = await this.carregar(tesourarias.map((t) => t.id));
    return tesourarias.map((t) => ({
      ...this.naTela(t),
      resumo: resumir(this.lancamentosDe(t.id, dados)),
    }));
  }

  /** Cria a tesouraria. A da congregação cria a congregação junto (nome e local). */
  async criar(churchId: string, dto: CriarTesourariaDto, quem: Solicitante) {
    this.exigirEquipe(churchId, quem);

    if (dto.kind === TreasuryKind.EVENT && dto.eventId) {
      const evento = await this.prisma.event.findFirst({
        where: { id: dto.eventId, churchId },
        select: { id: true, treasury: { select: { id: true } } },
      });
      if (!evento) throw new NotFoundException('Evento não encontrado');
      if (evento.treasury) {
        throw new ConflictException('Este evento já tem tesouraria');
      }
    } else if (!dto.name?.trim()) {
      throw new BadRequestException(
        dto.kind === TreasuryKind.EVENT
          ? 'Escolha um evento do sistema ou dê o nome do evento'
          : 'Dê o nome da congregação',
      );
    }

    const criada = await this.prisma.treasury.create({
      data: {
        churchId,
        kind: dto.kind,
        eventId: dto.kind === TreasuryKind.EVENT ? dto.eventId ?? null : null,
        name: dto.eventId ? null : dto.name?.trim(),
        date:
          dto.kind === TreasuryKind.EVENT && !dto.eventId && dto.date
            ? paraDia(dto.date)
            : null,
        location:
          dto.kind === TreasuryKind.CONGREGATION
            ? dto.location?.trim() || null
            : null,
        createdById: quem.userId,
      },
      include: {
        event: { select: { name: true, startDate: true, endDate: true } },
      },
    });
    return { ...this.naTela(criada), resumo: resumir([]) };
  }

  /** A tesouraria, com a conta e os bancos dela, e se quem pede pode fechar */
  async buscar(churchId: string, id: string, quem: Solicitante) {
    const t = await this.exigir(churchId, id, quem);
    const conta = await this.contaDa(churchId, t.kind);
    return {
      ...this.naTela(t),
      conta: CONTA_NA_TELA[conta.account],
      bancos: await this.bancosDa(churchId, conta.account),
      temBancoProprio: conta.propria,
      podeFechar: this.daEquipe(churchId, quem),
    };
  }

  async fechar(churchId: string, id: string, quem: Solicitante) {
    this.exigirEquipe(churchId, quem);
    await this.exigirAberta(churchId, id, quem);
    const pessoa = await this.prisma.user.findUnique({
      where: { id: quem.userId },
      select: { fullName: true },
    });
    await this.prisma.treasury.update({
      where: { id },
      data: {
        closedAt: new Date(),
        closedById: quem.userId,
        closedByName: pessoa?.fullName ?? null,
      },
    });
  }

  async reabrir(churchId: string, id: string, quem: Solicitante) {
    this.exigirEquipe(churchId, quem);
    await this.exigir(churchId, id, quem);
    await this.prisma.treasury.update({
      where: { id },
      data: { closedAt: null, closedById: null, closedByName: null },
    });
  }

  // ---- a distribuir e não alocados -------------------------------------------

  /**
   * O que a conta das tesourarias deste tipo ainda não distribuiu: os
   * movimentos que não foram (todos) para tesouraria nenhuma. É a lista de
   * "não alocados" e o lado do banco da conciliação.
   */
  async naoAlocados(churchId: string, kind: TreasuryKind, quem: Solicitante) {
    this.exigirEquipe(churchId, quem);
    const conta = await this.contaDa(churchId, kind);
    return {
      conta: CONTA_NA_TELA[conta.account],
      bancos: await this.bancosDa(churchId, conta.account),
      temBancoProprio: conta.propria,
      movimentos: await this.aDistribuir(churchId, conta.account),
    };
  }

  // ---- conciliação e lançamentos ---------------------------------------------

  /**
   * As linhas do diff da tesouraria: à esquerda o banco, à direita os
   * lançamentos dela (pagamentos e manuais no evento; o movimento trazido do
   * banco, que vira ele mesmo o lançamento). O que pede ação vem primeiro.
   *
   * - sugerido: o pagamento ou manual a conciliar com o movimento de mesmo
   *   valor e data próxima (`sugerirPares`, a regra da Administrativa);
   * - só no banco, só no evento, não consta e conciliado, como na
   *   Administrativa.
   */
  async conciliacao(churchId: string, id: string, quem: Solicitante) {
    const t = await this.exigir(churchId, id, quem);
    const conta = await this.contaDa(churchId, t.kind);
    const [livres, dados] = await Promise.all([
      this.aDistribuir(churchId, conta.account),
      this.carregar([id]),
    ]);
    const sistema = dados.sistema.get(id) ?? [];
    const alocacoes = dados.alocacoes.get(id) ?? [];

    // sugestões só entre o movimento inteiro ainda livre e o lançamento a
    // conciliar, um a um
    const aConciliar = sistema.filter((l) => l.situacao === 'A_CONCILIAR');
    const inteiros = livres.filter(
      (l) => centavos(l.restante) === centavos(l.movimento.valor),
    );
    const pares = sugerirPares(
      inteiros.map((l) => ({
        id: l.movimento.id,
        type: l.movimento.tipo,
        amount: l.movimento.valor,
        date: l.movimento.data,
        userId: null,
      })),
      aConciliar.map((l) => ({
        id: l.lancamento.id,
        type: l.lancamento.tipo,
        amount: l.lancamento.valor,
        date: l.lancamento.data,
        userId: null,
      })),
    );
    const sugeridos = new Set(pares.flatMap((p) => [p.bancoId, p.manualId]));
    const livrePorId = new Map(livres.map((l) => [l.movimento.id, l]));
    const sistemaPorId = new Map(sistema.map((l) => [l.lancamento.id, l]));

    const linhaDoSistema = (
      l: LinhaDoSistema,
      estado: LinhaDaConciliacao['estado'],
    ): LinhaDaConciliacao => ({
      chave: l.lancamento.id,
      estado,
      banco: null,
      continua: false,
      tesouraria: {
        de: 'sistema' as const,
        situacao: l.situacao,
        lancamento: l.lancamento,
        automatica: false,
      },
    });

    const linhas: LinhaDaConciliacao[] = [
      ...pares.map((p): LinhaDaConciliacao => {
        const livre = livrePorId.get(p.bancoId)!;
        const l = sistemaPorId.get(p.manualId)!;
        return {
          chave: `sugerido:${p.bancoId}:${p.manualId}`,
          estado: 'sugerido',
          banco: { movimento: livre.movimento, valor: livre.restante },
          continua: false,
          tesouraria: {
            de: 'sistema' as const,
            situacao: l.situacao,
            lancamento: l.lancamento,
            automatica: false,
          },
        };
      }),
      ...livres
        .filter((l) => !sugeridos.has(l.movimento.id))
        .map(
          (l): LinhaDaConciliacao => ({
            chave: l.movimento.id,
            estado: 'so_banco',
            banco: { movimento: l.movimento, valor: l.restante },
            continua: false,
            tesouraria: null,
          }),
        ),
      ...aConciliar
        .filter((l) => !sugeridos.has(l.lancamento.id))
        .map((l) => linhaDoSistema(l, 'so_evento')),
      ...sistema
        .filter((l) => l.situacao === 'NAO_CONSTA')
        .map((l) => linhaDoSistema(l, 'nao_consta')),
      ...alocacoes.flatMap(({ alocacao, movimento }): LinhaDaConciliacao[] => {
        const banco = { movimento, valor: alocacao.valor };
        const conciliados = sistema.filter(
          (l) => l.movimentoId === movimento.id,
        );
        if (!conciliados.length) {
          return [
            {
              chave: alocacao.id,
              estado: 'conciliado',
              banco,
              continua: false,
              tesouraria: { de: 'extrato' as const, alocacao },
            },
          ];
        }
        return conciliados.map((l, i) => ({
          chave: l.lancamento.id,
          estado: 'conciliado',
          banco,
          continua: i > 0,
          tesouraria: {
            de: 'sistema' as const,
            situacao: 'CONCILIADO' as const,
            lancamento: l.lancamento,
            automatica: false,
          },
        }));
      }),
    ];

    return {
      conta: CONTA_NA_TELA[conta.account],
      bancos: await this.bancosDa(churchId, conta.account),
      temBancoProprio: conta.propria,
      linhas,
      aConciliar: {
        quantos: aConciliar.length,
        saldo: reais(
          aConciliar.reduce(
            (s, l) => s + comSinal(l.lancamento.tipo, l.lancamento.valor),
            0,
          ),
        ),
      },
    };
  }

  /**
   * Os lançamentos da tesouraria: os do sistema (pagamentos e manuais, em
   * qualquer situação) e o que veio do banco sem par no sistema. O movimento
   * conciliado não entra: os lançamentos dele já contam aquele dinheiro.
   */
  async lancamentos(churchId: string, id: string, quem: Solicitante) {
    await this.exigir(churchId, id, quem);
    return this.lancamentosDe(id, await this.carregar([id]));
  }

  // ---- distribuir ------------------------------------------------------------

  /**
   * Traz movimentos do banco para a tesouraria: inteiros (sem `valor`) ou só
   * uma parte (rateio; o resto continua a distribuir). Trazer de novo soma na
   * alocação que já existe. Entra sem categoria.
   */
  async distribuir(
    churchId: string,
    id: string,
    partes: { movimentoId: string; valor?: number }[],
    quem: Solicitante,
  ) {
    const t = await this.exigirAberta(churchId, id, quem);
    const conta = await this.contaDa(churchId, t.kind);
    await this.prisma.$transaction(async (tx) => {
      for (const parte of partes) {
        const restante = await this.restanteDe(
          tx,
          churchId,
          conta.account,
          parte.movimentoId,
        );
        const valor = Math.min(parte.valor ?? restante, restante);
        if (centavos(valor) <= 0) {
          throw new BadRequestException(
            'Este movimento já foi todo distribuído',
          );
        }
        await tx.treasuryAllocation.upsert({
          where: {
            treasuryId_entryId: { treasuryId: id, entryId: parte.movimentoId },
          },
          create: {
            treasuryId: id,
            entryId: parte.movimentoId,
            amount: reais(valor),
            createdById: quem.userId,
          },
          update: { amount: { increment: reais(valor) } },
        });
      }
    });
  }

  /**
   * Devolve a alocação: o valor volta a distribuir, e o que ela conciliava
   * volta a conciliar.
   */
  async devolver(
    churchId: string,
    id: string,
    alocacaoId: string,
    quem: Solicitante,
  ) {
    await this.exigirAberta(churchId, id, quem);
    const alocacao = await this.prisma.treasuryAllocation.findFirst({
      where: { id: alocacaoId, treasuryId: id },
      select: { entryId: true },
    });
    if (!alocacao) throw new NotFoundException('Alocação não encontrada');
    await this.soltar(id, alocacao.entryId, alocacaoId);
  }

  async classificar(
    churchId: string,
    id: string,
    alocacaoId: string,
    categoria: string | null,
    quem: Solicitante,
  ) {
    const t = await this.exigirAberta(churchId, id, quem);
    const alocacao = await this.prisma.treasuryAllocation.findFirst({
      where: { id: alocacaoId, treasuryId: id },
      select: { entry: { select: { type: true } } },
    });
    if (!alocacao) throw new NotFoundException('Alocação não encontrada');
    if (categoria && !categoriaValida(t.kind, alocacao.entry.type, categoria)) {
      throw new BadRequestException('Categoria que não é deste tipo');
    }
    await this.prisma.treasuryAllocation.update({
      where: { id: alocacaoId },
      data: { category: categoria },
    });
  }

  // ---- conciliar com o sistema (evento) --------------------------------------

  /**
   * Concilia um movimento do banco com lançamentos do sistema que são o mesmo
   * dinheiro — um ou vários (o depósito de três inscrições). A soma deles
   * (entradas menos saídas) precisa bater com o banco ao centavo; a tarifa,
   * lança-se como saída e marca-se junto. O movimento ainda a distribuir vem
   * para a tesouraria, com a categoria do primeiro lançamento.
   */
  async conciliar(
    churchId: string,
    id: string,
    movimentoId: string,
    lancamentoIds: string[],
    quem: Solicitante,
  ) {
    const t = await this.exigirAberta(churchId, id, quem);
    const conta = await this.contaDa(churchId, t.kind);
    const dados = await this.carregar([id]);
    const marcados = (dados.sistema.get(id) ?? []).filter((l) =>
      lancamentoIds.includes(l.lancamento.id),
    );
    if (!marcados.length || marcados.length !== new Set(lancamentoIds).size) {
      throw new BadRequestException('Marque o banco e os lançamentos');
    }
    if (marcados.some((l) => l.situacao === 'CONCILIADO')) {
      throw new ConflictException('Um dos lançamentos já está conciliado');
    }
    if (
      (dados.sistema.get(id) ?? []).some((l) => l.movimentoId === movimentoId)
    ) {
      throw new ConflictException(
        'Este movimento já está conciliado: desfaça antes',
      );
    }

    const movimento = await this.prisma.financialEntry.findFirst({
      where: { id: movimentoId, churchId, source: FinancialEntrySource.PLUGGY },
      select: { type: true, amount: true },
    });
    if (!movimento) throw new NotFoundException('Movimento não encontrado');

    const aqui = await this.prisma.treasuryAllocation.findUnique({
      where: { treasuryId_entryId: { treasuryId: id, entryId: movimentoId } },
      select: { amount: true },
    });
    const doBanco = aqui
      ? Number(aqui.amount)
      : await this.restanteDe(
          this.prisma,
          churchId,
          conta.account,
          movimentoId,
        );
    const soma = marcados.reduce(
      (s, l) => s + comSinal(l.lancamento.tipo, l.lancamento.valor),
      0,
    );
    const banco = comSinal(movimento.type, doBanco);
    if (centavos(soma) !== centavos(banco)) {
      const brl = (v: number) =>
        v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      throw new BadRequestException(
        `O banco tem ${brl(banco)} e os lançamentos somam ${brl(
          soma,
        )}. Se a diferença é tarifa, lance-a como saída e marque junto.`,
      );
    }

    const { pagamentos, manuais } = separarIds(lancamentoIds);
    await this.prisma.$transaction(async (tx) => {
      if (!aqui) {
        await tx.treasuryAllocation.create({
          data: {
            treasuryId: id,
            entryId: movimentoId,
            amount: reais(doBanco),
            category: marcados[0].lancamento.categoria,
            createdById: quem.userId,
          },
        });
      }
      for (const paymentId of pagamentos) {
        await tx.treasuryPaymentLink.upsert({
          where: { paymentId },
          create: { paymentId, treasuryId: id, movementId: movimentoId },
          update: { movementId: movimentoId, notInBankAt: null },
        });
      }
      if (manuais.length) {
        await tx.treasuryEntry.updateMany({
          where: { id: { in: manuais }, treasuryId: id },
          data: { movementId: movimentoId, notInBankAt: null },
        });
      }
    });
  }

  /**
   * Desfaz a conciliação do movimento: ele volta para o banco, sem par, e os
   * lançamentos voltam a conciliar
   */
  async desfazer(
    churchId: string,
    id: string,
    movimentoId: string,
    quem: Solicitante,
  ) {
    await this.exigirAberta(churchId, id, quem);
    const alocacao = await this.prisma.treasuryAllocation.findUnique({
      where: { treasuryId_entryId: { treasuryId: id, entryId: movimentoId } },
      select: { id: true },
    });
    if (!alocacao) throw new NotFoundException('Conciliação não encontrada');
    await this.soltar(id, movimentoId, alocacao.id);
  }

  /** Confirma que não vai aparecer no extrato (dinheiro em espécie), ou volta */
  async naoConsta(
    churchId: string,
    id: string,
    lancamentoIds: string[],
    naoConsta: boolean,
    quem: Solicitante,
  ) {
    await this.exigirAberta(churchId, id, quem);
    const { pagamentos, manuais } = separarIds(lancamentoIds);
    const quando = naoConsta ? new Date() : null;
    const evento = await this.prisma.treasury.findUnique({
      where: { id },
      select: { eventId: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // só os pagamentos deste evento, e só os que não estão conciliados
      const validos = evento?.eventId
        ? await tx.payment.findMany({
            where: { id: { in: pagamentos }, eventId: evento.eventId },
            select: {
              id: true,
              treasuryLink: { select: { movementId: true } },
            },
          })
        : [];
      for (const p of validos) {
        if (p.treasuryLink?.movementId) continue;
        await tx.treasuryPaymentLink.upsert({
          where: { paymentId: p.id },
          create: { paymentId: p.id, treasuryId: id, notInBankAt: quando },
          update: { notInBankAt: quando },
        });
      }
      if (manuais.length) {
        await tx.treasuryEntry.updateMany({
          where: { id: { in: manuais }, treasuryId: id, movementId: null },
          data: { notInBankAt: quando },
        });
      }
    });
  }

  /** Lançamento manual da tesouraria do evento: entra a conciliar */
  async novoLancamento(
    churchId: string,
    id: string,
    dto: LancamentoDaTesourariaDto,
    quem: Solicitante,
  ) {
    const t = await this.exigirAberta(churchId, id, quem);
    if (t.kind !== TreasuryKind.EVENT) {
      throw new BadRequestException(
        'A congregação não tem lançamento manual: o que veio do banco já é o lançamento',
      );
    }
    if (!categoriaValida(t.kind, dto.type, dto.category)) {
      throw new BadRequestException('Categoria que não é deste tipo');
    }
    await this.prisma.treasuryEntry.create({
      data: {
        treasuryId: id,
        type: dto.type,
        category: dto.category,
        description: dto.description.trim(),
        amount: dto.amount,
        date: paraDia(dto.date),
        method: dto.method ?? null,
        createdById: quem.userId,
      },
    });
  }

  // ---- por dentro ------------------------------------------------------------

  /** A equipe da igreja: admin e tesouraria dela, e dev e super admin */
  private daEquipe(churchId: string, quem: Solicitante) {
    return (
      isSuperAdmin(quem) ||
      churchIdsComPerfil(quem, ADMIN_AREA_ROLES).includes(churchId)
    );
  }

  private exigirEquipe(churchId: string, quem: Solicitante) {
    if (!this.daEquipe(churchId, quem)) {
      throw new ForbiddenException(
        'Só o admin e a tesouraria da igreja fazem isto',
      );
    }
  }

  /** Os eventos desta igreja em que a pessoa é tesoureira completa */
  private async eventosDoTesoureiro(userId: string, churchId: string) {
    const vinculos = await this.prisma.eventTreasurer.findMany({
      where: {
        userId,
        kind: EventTreasurerKind.COMPLETO,
        event: { churchId },
      },
      select: { eventId: true },
    });
    return vinculos.map((v) => v.eventId);
  }

  /** A tesouraria desta igreja que a pessoa alcança, ou 404/403 */
  private async exigir(churchId: string, id: string, quem: Solicitante) {
    const t = await this.prisma.treasury.findFirst({
      where: { id, churchId },
      include: {
        event: { select: { name: true, startDate: true, endDate: true } },
      },
    });
    if (!t) throw new NotFoundException('Tesouraria não encontrada');
    if (this.daEquipe(churchId, quem)) return t;
    const meus = await this.eventosDoTesoureiro(quem.userId, churchId);
    if (!t.eventId || !meus.includes(t.eventId)) {
      throw new ForbiddenException('Você não é tesoureiro(a) deste evento');
    }
    return t;
  }

  private async exigirAberta(churchId: string, id: string, quem: Solicitante) {
    const t = await this.exigir(churchId, id, quem);
    if (t.closedAt) {
      throw new BadRequestException(
        'A tesouraria está fechada: reabra para mudar',
      );
    }
    return t;
  }

  /**
   * A conta de onde a tesouraria distribui: a do tipo dela, com os bancos
   * divididos e algum banco nela; senão a Administrativa (a conta única).
   */
  private async contaDa(churchId: string, kind: TreasuryKind) {
    const integracao = await this.prisma.pluggyIntegration.findUnique({
      where: { churchId },
      select: { splitByTreasury: true, itemAccounts: true, itemIds: true },
    });
    const propria = CONTA_DO_TIPO[kind];
    const temBanco =
      !!integracao &&
      integracao.itemIds.some(
        (itemId) => contaDoBanco(integracao, itemId) === propria,
      );
    return temBanco
      ? { account: propria, propria: true }
      : { account: TreasuryAccount.ADMINISTRATIVE, propria: false };
  }

  /** Os bancos de uma conta ("Sicredi", "PagBank"), pelos movimentos dela */
  private async bancosDa(churchId: string, account: TreasuryAccount) {
    const contas = await this.prisma.financialEntry.findMany({
      where: {
        churchId,
        account,
        source: FinancialEntrySource.PLUGGY,
        bankAccount: { not: null },
      },
      distinct: ['bankAccount'],
      select: { bankAccount: true },
    });
    return [...new Set(contas.map((c) => bancoDe(c.bankAccount)))];
  }

  /** O que falta distribuir de cada movimento da conta (do mais recente) */
  private async aDistribuir(churchId: string, account: TreasuryAccount) {
    const desde = diaEmBrasilia(
      new Date(Date.now() - JANELA_DIAS * 86_400_000).toISOString(),
    );
    const movimentos = await this.prisma.financialEntry.findMany({
      where: {
        churchId,
        account,
        source: FinancialEntrySource.PLUGGY,
        date: { gte: paraDia(desde) },
        // na conta única, o que a Administrativa já conciliou é dela
        ...(account === TreasuryAccount.ADMINISTRATIVE
          ? { reconciledBy: { is: null } }
          : {}),
      },
      select: {
        ...SELECT_MOVIMENTO,
        allocations: { select: { amount: true } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return movimentos
      .map(({ allocations, ...m }) => ({
        movimento: movimentoNaTela(m),
        restante: reais(
          Number(m.amount) -
            allocations.reduce((s, a) => s + Number(a.amount), 0),
        ),
      }))
      .filter((l) => centavos(l.restante) > 0);
  }

  private async restanteDe(
    tx: Prisma.TransactionClient | PrismaService,
    churchId: string,
    account: TreasuryAccount,
    movimentoId: string,
  ) {
    const m = await tx.financialEntry.findFirst({
      where: {
        id: movimentoId,
        churchId,
        account,
        source: FinancialEntrySource.PLUGGY,
      },
      select: { amount: true, allocations: { select: { amount: true } } },
    });
    if (!m) {
      throw new NotFoundException(
        'Movimento não encontrado na conta desta tesouraria',
      );
    }
    return reais(
      Number(m.amount) -
        m.allocations.reduce((s, a) => s + Number(a.amount), 0),
    );
  }

  /** Apaga a alocação e solta o que ela conciliava */
  private async soltar(id: string, movimentoId: string, alocacaoId: string) {
    await this.prisma.$transaction([
      this.prisma.treasuryPaymentLink.updateMany({
        where: { treasuryId: id, movementId: movimentoId },
        data: { movementId: null },
      }),
      this.prisma.treasuryEntry.updateMany({
        where: { treasuryId: id, movementId: movimentoId },
        data: { movementId: null },
      }),
      this.prisma.treasuryAllocation.delete({ where: { id: alocacaoId } }),
    ]);
  }

  /**
   * Tudo de um lote de tesourarias de uma vez: as alocações (com o
   * movimento), os manuais e os pagamentos dos eventos delas
   */
  private async carregar(ids: string[]) {
    const [tesourarias, alocacoes, manuais] = await Promise.all([
      this.prisma.treasury.findMany({
        where: { id: { in: ids } },
        select: { id: true, eventId: true },
      }),
      this.prisma.treasuryAllocation.findMany({
        where: { treasuryId: { in: ids } },
        include: { entry: { select: SELECT_MOVIMENTO } },
      }),
      this.prisma.treasuryEntry.findMany({
        where: { treasuryId: { in: ids } },
      }),
    ]);

    const tesourariaDoEvento = new Map(
      tesourarias.filter((t) => t.eventId).map((t) => [t.eventId!, t.id]),
    );
    const pagamentos = tesourariaDoEvento.size
      ? await this.prisma.payment.findMany({
          where: {
            eventId: { in: [...tesourariaDoEvento.keys()] },
            status: PaymentStatus.PAID,
          },
          include: {
            treasuryLink: true,
            productItems: { select: { id: true } },
            checkouts: {
              select: { referenceId: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        })
      : [];
    const pessoas = new Map(
      (
        await this.prisma.user.findMany({
          where: {
            id: {
              in: pagamentos.map((p) => p.userId).filter(Boolean) as string[],
            },
          },
          select: { id: true, fullName: true },
        })
      ).map((u) => [u.id, u.fullName]),
    );

    const sistema = new Map<string, LinhaDoSistema[]>();
    const junto = (id: string, linha: LinhaDoSistema) =>
      sistema.set(id, [...(sistema.get(id) ?? []), linha]);
    const situacao = (movementId?: string | null, notInBankAt?: Date | null) =>
      movementId ? 'CONCILIADO' : notInBankAt ? 'NAO_CONSTA' : 'A_CONCILIAR';

    for (const p of pagamentos) {
      const tesourariaId = tesourariaDoEvento.get(p.eventId as string)!;
      const produto = !p.roleRegistrationId && p.productItems.length > 0;
      const quem = (p.userId && pessoas.get(p.userId)) || null;
      junto(tesourariaId, {
        lancamento: {
          id: idDoPagamento(p.id),
          tesourariaId,
          origem: produto ? 'PRODUTO' : 'INSCRICAO',
          tipo: FinancialEntryType.INCOME,
          categoria: produto ? 'Produtos' : 'Ingressos',
          descricao: `${produto ? 'Produtos' : 'Inscrição'}${
            quem ? ` — ${quem}` : ''
          }`,
          valor: reais(p.amount),
          // ponytail: o pagamento não guarda quando foi pago; a última
          // mudança dele é o melhor que há (a baixa ou o retorno do gateway)
          data: diaEmBrasilia(p.updatedAt.toISOString()),
          forma: FORMA_DO_PAGAMENTO[p.method],
          // o pago pelo site tem a referência do checkout; a baixa manual não
          codigo:
            p.receivedFrom === PaymentReceived.SYSTEM
              ? p.checkouts[0]?.referenceId ?? null
              : null,
        },
        situacao: situacao(
          p.treasuryLink?.movementId,
          p.treasuryLink?.notInBankAt,
        ),
        movimentoId: p.treasuryLink?.movementId ?? null,
      });
    }
    for (const m of manuais) {
      junto(m.treasuryId, {
        lancamento: {
          id: idDoManual(m.id),
          tesourariaId: m.treasuryId,
          origem: 'MANUAL',
          tipo: m.type,
          categoria: m.category,
          descricao: m.description,
          valor: Number(m.amount),
          data: doDia(m.date) as string,
          forma: m.method ? FORMA_DO_MANUAL[m.method] : null,
          codigo: null,
        },
        situacao: situacao(m.movementId, m.notInBankAt),
        movimentoId: m.movementId,
      });
    }
    for (const linhas of sistema.values()) {
      linhas.sort((a, b) => b.lancamento.data.localeCompare(a.lancamento.data));
    }

    const porTesouraria = new Map<
      string,
      { alocacao: Alocacao; movimento: Movimento }[]
    >();
    for (const a of alocacoes) {
      const linha = {
        alocacao: {
          id: a.id,
          movimentoId: a.entryId,
          tesourariaId: a.treasuryId,
          valor: Number(a.amount),
          categoria: a.category,
        },
        movimento: movimentoNaTela(a.entry),
      };
      porTesouraria.set(a.treasuryId, [
        ...(porTesouraria.get(a.treasuryId) ?? []),
        linha,
      ]);
    }
    for (const linhas of porTesouraria.values()) {
      linhas.sort((a, b) => b.movimento.data.localeCompare(a.movimento.data));
    }

    return { sistema, alocacoes: porTesouraria };
  }

  private lancamentosDe(
    id: string,
    dados: Awaited<ReturnType<TesourariasService['carregar']>>,
  ) {
    const sistema = dados.sistema.get(id) ?? [];
    const alocacoes = dados.alocacoes.get(id) ?? [];
    const bancoDoMovimento = new Map(
      alocacoes.map((a) => [a.movimento.id, a.movimento.banco]),
    );
    const conciliados = new Set(
      sistema.map((l) => l.movimentoId).filter(Boolean) as string[],
    );
    return [
      ...sistema.map(({ lancamento: l, situacao, movimentoId }) => ({
        id: l.id,
        tesourariaId: id,
        tipo: l.tipo,
        categoria: l.categoria,
        descricao: l.descricao,
        valor: l.valor,
        data: l.data,
        origem: l.origem,
        banco: movimentoId ? bancoDoMovimento.get(movimentoId) ?? null : null,
        situacao,
      })),
      ...alocacoes
        .filter(({ movimento }) => !conciliados.has(movimento.id))
        .map(({ alocacao, movimento: m }) => ({
          id: alocacao.id,
          tesourariaId: id,
          tipo: m.tipo,
          categoria: alocacao.categoria ?? SEM_CATEGORIA,
          descricao: m.pagador ? `${m.descricao} — ${m.pagador}` : m.descricao,
          valor: alocacao.valor,
          data: m.data,
          origem: 'BANCO' as const,
          banco: m.banco,
          situacao: null,
        })),
    ];
  }

  /** A tesouraria como a lista e o cabeçalho mostram */
  private naTela(
    t: Prisma.TreasuryGetPayload<{
      include: {
        event: { select: { name: true; startDate: true; endDate: true } };
      };
    }>,
  ) {
    const evento = t.event;
    return {
      id: t.id,
      tipo: t.kind,
      nome: evento?.name ?? t.name ?? '',
      eventoId: t.eventId,
      periodo: evento
        ? periodoDe(
            diaEmBrasilia(evento.startDate.toISOString()),
            diaEmBrasilia(evento.endDate.toISOString()),
          )
        : periodoDe(doDia(t.date), null),
      local: t.location,
      fechamento: t.closedAt
        ? {
            em: diaEmBrasilia(t.closedAt.toISOString()),
            por: t.closedByName ?? '',
          }
        : null,
    };
  }
}

/** Entradas, saídas e o resultado de uma lista de lançamentos */
export function resumir(
  lancamentos: { tipo: FinancialEntryType; valor: number }[],
) {
  let entradas = 0;
  let saidas = 0;
  for (const l of lancamentos) {
    if (l.tipo === FinancialEntryType.INCOME) entradas += l.valor;
    else saidas += l.valor;
  }
  return {
    entradas: reais(entradas),
    saidas: reais(saidas),
    saldo: reais(entradas - saidas),
  };
}
