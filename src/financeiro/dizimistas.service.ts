import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FinancialCategory, FinancialEntryType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { diaEmBrasilia } from './categorias';
import { CreateTitherDto, UpdateTitherDto } from './dto/financeiro.dto';

const USUARIO = {
  id: true,
  fullName: true,
  cpf: true,
  cellphone: true,
  email: true,
  profilePhotoUrl: true,
} as const;

/** "2026-10-03" → meia-noite UTC, que é como o `@db.Date` guarda o dia */
export const paraDia = (dia: string) => new Date(`${dia}T00:00:00.000Z`);
/** O inverso: o dia gravado como "2026-10-03", sem passar por fuso */
export const doDia = (data: Date | null) =>
  data ? data.toISOString().slice(0, 10) : null;

/** CPF pela metade, para a busca de quem adicionar: o nome já identifica */
const cpfMascarado = (cpf: string) =>
  cpf.length === 11 ? `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**` : '***';

/**
 * Dizimistas da igreja. Toda leitura e escrita é pela igreja da rota (o
 * `ChurchTenantGuard` já conferiu que a pessoa alcança ela) **e** pelo id do
 * registro junto: um id de dizimista de outra igreja responde 404, não altera.
 */
@Injectable()
export class DizimistasService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A lista com os números do ano: total dizimado, em quais meses e o último
   * dízimo. Os números saem dos lançamentos de dízimo ligados à pessoa —
   * manuais ou importados do banco.
   */
  async listar(churchId: string, ano: number) {
    const dizimistas = await this.prisma.tither.findMany({
      where: { churchId },
      include: { user: { select: USUARIO } },
      orderBy: { user: { fullName: 'asc' } },
    });

    const userIds = dizimistas.map((d) => d.userId);
    const dizimos = userIds.length
      ? await this.prisma.financialEntry.findMany({
          where: {
            churchId,
            type: FinancialEntryType.INCOME,
            category: FinancialCategory.TITHE,
            userId: { in: userIds },
          },
          select: { userId: true, amount: true, date: true },
        })
      : [];

    const hoje = diaEmBrasilia(new Date().toISOString());
    const mesAtual = hoje.slice(0, 7);
    const doAno = `${ano}-`;

    const porPessoa = new Map<
      string,
      { total: number; meses: Set<number>; ultimo: string | null }
    >();
    let totalNoAno = 0;
    let totalNoMes = 0;
    const dizimaramNoMes = new Set<string>();

    for (const d of dizimos) {
      const dia = doDia(d.date) as string;
      const valor = Number(d.amount);
      const pessoa = porPessoa.get(d.userId as string) ?? {
        total: 0,
        meses: new Set<number>(),
        ultimo: null,
      };
      if (!pessoa.ultimo || dia > pessoa.ultimo) pessoa.ultimo = dia;
      if (dia.startsWith(doAno)) {
        pessoa.total += valor;
        pessoa.meses.add(Number(dia.slice(5, 7)));
        totalNoAno += valor;
      }
      if (dia.startsWith(mesAtual)) {
        totalNoMes += valor;
        dizimaramNoMes.add(d.userId as string);
      }
      porPessoa.set(d.userId as string, pessoa);
    }

    return {
      ano,
      resumo: {
        ativos: dizimistas.filter((d) => d.active).length,
        dizimaramNoMes: dizimaramNoMes.size,
        totalNoMes: arredondar(totalNoMes),
        totalNoAno: arredondar(totalNoAno),
      },
      dizimistas: dizimistas.map((d) => {
        const pessoa = porPessoa.get(d.userId);
        return {
          id: d.id,
          active: d.active,
          since: doDia(d.since),
          notes: d.notes,
          expectedAmount:
            d.expectedAmount === null ? null : Number(d.expectedAmount),
          user: d.user,
          totalNoAno: arredondar(pessoa?.total ?? 0),
          mesesNoAno: [...(pessoa?.meses ?? [])].sort((a, b) => a - b),
          ultimoDizimo: pessoa?.ultimo ?? null,
        };
      }),
    };
  }

  /**
   * Quem pode virar dizimista: qualquer usuário do sistema, pelo nome (3+
   * letras) ou pelo CPF completo. A pessoa pode nunca ter ido a um evento
   * desta igreja e ainda assim dizimar nela. Volta pouco — nome, foto e o CPF
   * pela metade —, e no máximo 20.
   */
  async buscarUsuarios(churchId: string, busca: string) {
    const texto = busca.trim();
    const digitos = texto.replace(/\D/g, '');
    const porCpf = digitos.length === 11;
    if (!porCpf && texto.length < 3) return [];

    const usuarios = await this.prisma.user.findMany({
      where: porCpf
        ? { cpf: digitos }
        : { fullName: { contains: texto, mode: 'insensitive' } },
      select: { id: true, fullName: true, cpf: true, profilePhotoUrl: true },
      orderBy: { fullName: 'asc' },
      take: 20,
    });

    const ja = await this.prisma.tither.findMany({
      where: { churchId, userId: { in: usuarios.map((u) => u.id) } },
      select: { userId: true },
    });
    const jaSet = new Set(ja.map((t) => t.userId));

    return usuarios.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      cpf: cpfMascarado(u.cpf),
      profilePhotoUrl: u.profilePhotoUrl,
      jaDizimista: jaSet.has(u.id),
    }));
  }

  async criar(churchId: string, dto: CreateTitherDto, actorId?: string) {
    const usuario = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { id: true },
    });
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    try {
      return await this.prisma.tither.create({
        data: {
          churchId,
          userId: dto.userId,
          since: dto.since ? paraDia(dto.since) : null,
          notes: dto.notes?.trim() || null,
          expectedAmount: dto.expectedAmount ?? null,
          createdById: actorId ?? null,
          updatedById: actorId ?? null,
        },
      });
    } catch (erro) {
      if ((erro as { code?: string })?.code === 'P2002') {
        throw new ConflictException('Esta pessoa já é dizimista desta igreja');
      }
      throw erro;
    }
  }

  async atualizar(
    churchId: string,
    id: string,
    dto: UpdateTitherDto,
    actorId?: string,
  ) {
    await this.exigir(churchId, id);
    return this.prisma.tither.update({
      where: { id },
      data: {
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.since !== undefined
          ? { since: dto.since ? paraDia(dto.since) : null }
          : {}),
        ...(dto.notes !== undefined
          ? { notes: dto.notes?.trim() || null }
          : {}),
        ...(dto.expectedAmount !== undefined
          ? { expectedAmount: dto.expectedAmount }
          : {}),
        updatedById: actorId ?? null,
      },
    });
  }

  /** Tira da lista. Os dízimos lançados continuam no livro-caixa. */
  async remover(churchId: string, id: string) {
    await this.exigir(churchId, id);
    await this.prisma.tither.delete({ where: { id } });
  }

  private async exigir(churchId: string, id: string) {
    const dizimista = await this.prisma.tither.findFirst({
      where: { id, churchId },
      select: { id: true },
    });
    if (!dizimista) throw new NotFoundException('Dizimista não encontrado');
    return dizimista;
  }
}

/** Soma de `Decimal` convertida: arredonda o resíduo de ponto flutuante */
export const arredondar = (valor: number) => Math.round(valor * 100) / 100;
