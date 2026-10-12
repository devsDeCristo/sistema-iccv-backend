import { Injectable, NotFoundException } from '@nestjs/common';
import { FinancialCategory, FinancialEntryType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { diaEmBrasilia } from './categorias';

/** "2026-10-03" → meia-noite UTC, que é como o `@db.Date` guarda o dia */
export const paraDia = (dia: string) => new Date(`${dia}T00:00:00.000Z`);
/** O inverso: o dia gravado como "2026-10-03", sem passar por fuso */
export const doDia = (data: Date | null) =>
  data ? data.toISOString().slice(0, 10) : null;

/** Soma de `Decimal` convertida: arredonda o resíduo de ponto flutuante */
export const arredondar = (valor: number) => Math.round(valor * 100) / 100;

/**
 * Dizimistas da igreja: **todos os membros** dela — todo membro é um dizimista
 * em potencial, e não há cadastro à parte. O que a tesouraria ajusta é o
 * valor do dízimo de cada um (`User.titheAmount`), que separa dízimo de oferta
 * na importação do banco.
 *
 * Toda leitura e escrita é pela igreja da rota (o `ChurchTenantGuard` já
 * conferiu que a pessoa alcança ela) e pelo membro junto: quem não é membro
 * desta igreja responde 404.
 */
@Injectable()
export class DizimistasService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Os membros com os números do ano: total dizimado, quanto em cada mês (a
   * visão por mês da tela), em quais meses e o último dízimo. Os números saem dos lançamentos de dízimo desta igreja
   * ligados à pessoa — manuais ou importados do banco.
   */
  async listar(churchId: string, ano: number) {
    const membros = await this.prisma.user.findMany({
      where: { memberChurchId: churchId },
      select: {
        id: true,
        fullName: true,
        cpf: true,
        cellphone: true,
        email: true,
        profilePhotoUrl: true,
        memberSince: true,
        titheAmount: true,
        family: { select: { id: true, name: true } },
      },
      orderBy: { fullName: 'asc' },
    });

    const dizimos = membros.length
      ? await this.prisma.financialEntry.findMany({
          where: {
            churchId,
            type: FinancialEntryType.INCOME,
            category: FinancialCategory.TITHE,
            userId: { in: membros.map((m) => m.id) },
            // o manual conciliado já conta pelo do banco, que herdou o dizimista
            reconciledWithId: null,
          },
          select: { userId: true, amount: true, date: true },
        })
      : [];

    const hoje = diaEmBrasilia(new Date().toISOString());
    const mesAtual = hoje.slice(0, 7);
    const doAno = `${ano}-`;

    const porPessoa = new Map<
      string,
      {
        total: number;
        meses: Set<number>;
        /** o dízimo de cada mês do ano, janeiro a dezembro */
        porMes: number[];
        ultimo: string | null;
      }
    >();
    /** o total da igreja em cada mês do ano */
    const daIgrejaPorMes = Array<number>(12).fill(0);
    let totalNoAno = 0;
    let totalNoMes = 0;
    const dizimaramNoMes = new Set<string>();
    const dizimaramNoAno = new Set<string>();

    for (const d of dizimos) {
      const dia = doDia(d.date) as string;
      const valor = Number(d.amount);
      const userId = d.userId as string;
      const pessoa = porPessoa.get(userId) ?? {
        total: 0,
        meses: new Set<number>(),
        porMes: Array<number>(12).fill(0),
        ultimo: null,
      };
      if (!pessoa.ultimo || dia > pessoa.ultimo) pessoa.ultimo = dia;
      if (dia.startsWith(doAno)) {
        const mes = Number(dia.slice(5, 7));
        pessoa.total += valor;
        pessoa.meses.add(mes);
        pessoa.porMes[mes - 1] += valor;
        daIgrejaPorMes[mes - 1] += valor;
        totalNoAno += valor;
        dizimaramNoAno.add(userId);
      }
      if (dia.startsWith(mesAtual)) {
        totalNoMes += valor;
        dizimaramNoMes.add(userId);
      }
      porPessoa.set(userId, pessoa);
    }

    return {
      ano,
      resumo: {
        membros: membros.length,
        dizimaramNoMes: dizimaramNoMes.size,
        dizimaramNoAno: dizimaramNoAno.size,
        totalNoMes: arredondar(totalNoMes),
        totalNoAno: arredondar(totalNoAno),
        porMes: daIgrejaPorMes.map(arredondar),
      },
      dizimistas: membros.map((m) => {
        const pessoa = porPessoa.get(m.id);
        return {
          ...m,
          titheAmount: m.titheAmount === null ? null : Number(m.titheAmount),
          totalNoAno: arredondar(pessoa?.total ?? 0),
          mesesNoAno: [...(pessoa?.meses ?? [])].sort((a, b) => a - b),
          porMes: (pessoa?.porMes ?? Array<number>(12).fill(0)).map(arredondar),
          ultimoDizimo: pessoa?.ultimo ?? null,
        };
      }),
    };
  }

  /** O valor do dízimo do membro. `null` tira: todo Pix dele vira dízimo. */
  async definirValor(churchId: string, userId: string, valor: number | null) {
    const membro = await this.prisma.user.findFirst({
      where: { id: userId, memberChurchId: churchId },
      select: { id: true },
    });
    if (!membro) throw new NotFoundException('Membro não encontrado');
    await this.prisma.user.update({
      where: { id: userId },
      data: { titheAmount: valor },
    });
  }
}
