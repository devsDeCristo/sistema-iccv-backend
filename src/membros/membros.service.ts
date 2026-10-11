import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { AtualizarFamiliaDto, CriarFamiliaDto } from './membros.dto';

const PESSOA = {
  id: true,
  fullName: true,
  cpf: true,
  cellphone: true,
  email: true,
  profilePhotoUrl: true,
} as const;

/** CPF pela metade, para a busca: o nome já identifica */
export const cpfMascarado = (cpf: string) =>
  cpf.length === 11 ? `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**` : '***';

/**
 * Como a busca de pessoas entende o texto: CPF completo, ou pelo menos dois
 * nomes (cada um com 2+ letras), todos presentes no nome completo. Um nome só
 * ("Maria") traria metade do cadastro do sistema — e o sistema é de todas as
 * igrejas.
 *
 * `null`: o texto ainda não é uma busca válida.
 */
export function filtroDaBusca(texto: string): Prisma.UserWhereInput | null {
  const digitos = texto.replace(/\D/g, '');
  if (digitos.length === 11) return { cpf: digitos };

  const nomes = texto
    .trim()
    .split(/\s+/)
    .filter((nome) => nome.replace(/\d/g, '').length >= 2);
  if (nomes.length < 2) return null;

  return {
    AND: nomes.map((nome) => ({
      fullName: { contains: nome, mode: 'insensitive' as const },
    })),
  };
}

/**
 * Membros da igreja e as famílias deles.
 *
 * Membro é o usuário com `memberChurchId` desta igreja — uma igreja por pessoa,
 * garantido por ser campo. Quem entra: o admin ou o financeiro coloca (busca)
 * ou aceita o pedido feito na inscrição. Toda escrita confere que a pessoa ou
 * a família é **desta** igreja; a rota já passou pelo `ChurchTenantGuard`.
 */
@Injectable()
export class MembrosService {
  constructor(private readonly prisma: PrismaService) {}

  /** Membros (com família), famílias e pedidos pendentes */
  async listar(churchId: string) {
    const [membros, familias, pendentes] = await Promise.all([
      this.prisma.user.findMany({
        where: { memberChurchId: churchId },
        select: {
          ...PESSOA,
          memberSince: true,
          family: { select: { id: true, name: true } },
        },
        orderBy: { fullName: 'asc' },
      }),
      this.prisma.family.findMany({
        where: { churchId },
        select: { id: true, name: true, _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { requestedChurchId: churchId },
        select: { ...PESSOA, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      membros,
      familias: familias.map((f) => ({
        id: f.id,
        name: f.name,
        membros: f._count.members,
      })),
      pendentes,
    };
  }

  /**
   * Quem colocar como membro: qualquer pessoa do sistema, pelo CPF completo ou
   * por pelo menos dois nomes. Volta pouco (nome, foto, CPF pela metade) e a
   * situação: membro de qual igreja, se pediu para entrar nesta, ou a igreja
   * que escreveu em "Outra" na inscrição.
   */
  async buscar(churchId: string, busca: string) {
    const filtro = filtroDaBusca(busca);
    if (!filtro) return [];

    const pessoas = await this.prisma.user.findMany({
      where: filtro,
      select: {
        id: true,
        fullName: true,
        cpf: true,
        profilePhotoUrl: true,
        requestedChurchId: true,
        otherChurchName: true,
        memberChurch: { select: { id: true, name: true } },
      },
      orderBy: { fullName: 'asc' },
      take: 20,
    });

    return pessoas.map((p) => ({
      id: p.id,
      fullName: p.fullName,
      cpf: cpfMascarado(p.cpf),
      profilePhotoUrl: p.profilePhotoUrl,
      membroDe: p.memberChurch,
      pediuEsta: p.requestedChurchId === churchId,
      outraIgreja: p.otherChurchName,
    }));
  }

  /** Coloca como membro. Quem já é membro de outra igreja não entra. */
  async adicionar(churchId: string, userId: string) {
    const pessoa = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        memberChurchId: true,
        memberChurch: { select: { name: true } },
      },
    });
    if (!pessoa) throw new NotFoundException('Pessoa não encontrada');
    if (pessoa.memberChurchId === churchId) {
      throw new ConflictException('Esta pessoa já é membro desta igreja');
    }
    if (pessoa.memberChurchId) {
      throw new ConflictException(
        `Esta pessoa é membro de ${pessoa.memberChurch?.name}. Quem administra lá precisa tirá-la antes.`,
      );
    }
    await this.tornarMembro(churchId, userId);
  }

  /** Aceita o pedido feito na inscrição */
  async aceitar(churchId: string, userId: string) {
    const pessoa = await this.exigirPedido(churchId, userId);
    if (pessoa.memberChurchId) {
      throw new ConflictException('Esta pessoa já é membro de uma igreja');
    }
    await this.tornarMembro(churchId, userId);
  }

  async recusar(churchId: string, userId: string) {
    await this.exigirPedido(churchId, userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { requestedChurchId: null },
    });
  }

  /**
   * Deixa de ser membro: sai da família e perde o valor do dízimo combinado
   * aqui (os lançamentos dele continuam no livro-caixa).
   */
  async remover(churchId: string, userId: string) {
    const membro = await this.exigirMembro(churchId, userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        memberChurchId: null,
        memberSince: null,
        familyId: null,
        titheAmount: null,
      },
    });
    await this.apagarSeVazia(membro.familyId);
  }

  // ---- famílias --------------------------------------------------------------

  async criarFamilia(churchId: string, dto: CriarFamiliaDto, actorId?: string) {
    const anteriores = await this.exigirMembros(churchId, dto.userIds);
    const familia = await this.prisma.family.create({
      data: {
        churchId,
        name: dto.nome.trim(),
        createdById: actorId ?? null,
        updatedById: actorId ?? null,
      },
    });
    await this.prisma.user.updateMany({
      where: { id: { in: dto.userIds } },
      data: { familyId: familia.id },
    });
    await this.apagarVazias(anteriores);
    return familia;
  }

  async atualizarFamilia(
    churchId: string,
    id: string,
    dto: AtualizarFamiliaDto,
    actorId?: string,
  ) {
    await this.exigirFamilia(churchId, id);

    if (dto.adicionar?.length) {
      const anteriores = await this.exigirMembros(churchId, dto.adicionar);
      await this.prisma.user.updateMany({
        where: { id: { in: dto.adicionar } },
        data: { familyId: id },
      });
      await this.apagarVazias(anteriores.filter((f) => f !== id));
    }

    return this.prisma.family.update({
      where: { id },
      data: {
        ...(dto.nome ? { name: dto.nome.trim() } : {}),
        updatedById: actorId ?? null,
      },
    });
  }

  /** Desfaz a família: as pessoas continuam membros, sem família */
  async desfazerFamilia(churchId: string, id: string) {
    await this.exigirFamilia(churchId, id);
    await this.prisma.user.updateMany({
      where: { familyId: id },
      data: { familyId: null },
    });
    await this.prisma.family.delete({ where: { id } });
  }

  async tirarDaFamilia(churchId: string, userId: string) {
    const membro = await this.exigirMembro(churchId, userId);
    if (!membro.familyId) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { familyId: null },
    });
    await this.apagarSeVazia(membro.familyId);
  }

  // ----------------------------------------------------------------------------

  /**
   * Só grava se a pessoa ainda não é membro de ninguém, na mesma instrução:
   * duas igrejas colocando a mesma pessoa ao mesmo tempo não sobrescrevem uma
   * à outra — a segunda recebe o conflito.
   */
  /** Atômico: só entra quem não é membro de nenhuma igreja (409 se já é) */
  async tornarMembro(churchId: string, userId: string) {
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, memberChurchId: null },
      // o pedido, se havia, está atendido; "Outra" deixa de valer
      data: {
        memberChurchId: churchId,
        memberSince: new Date(),
        requestedChurchId: null,
        otherChurchName: null,
      },
    });
    if (!count) {
      throw new ConflictException('Esta pessoa já é membro de uma igreja');
    }
  }

  private async exigirMembro(churchId: string, userId: string) {
    const membro = await this.prisma.user.findFirst({
      where: { id: userId, memberChurchId: churchId },
      select: { id: true, familyId: true },
    });
    if (!membro) throw new NotFoundException('Membro não encontrado');
    return membro;
  }

  /** Todos precisam ser membros desta igreja. Devolve as famílias de onde saem. */
  private async exigirMembros(churchId: string, userIds: string[]) {
    const membros = await this.prisma.user.findMany({
      where: { id: { in: userIds }, memberChurchId: churchId },
      select: { familyId: true },
    });
    if (membros.length !== new Set(userIds).size) {
      throw new BadRequestException(
        'Só membros desta igreja entram na família',
      );
    }
    return [
      ...new Set(membros.map((m) => m.familyId).filter(Boolean)),
    ] as string[];
  }

  private async exigirPedido(churchId: string, userId: string) {
    const pessoa = await this.prisma.user.findFirst({
      where: { id: userId, requestedChurchId: churchId },
      select: { memberChurchId: true },
    });
    if (!pessoa) throw new NotFoundException('Pedido não encontrado');
    return pessoa;
  }

  private async exigirFamilia(churchId: string, id: string) {
    const familia = await this.prisma.family.findFirst({
      where: { id, churchId },
      select: { id: true },
    });
    if (!familia) throw new NotFoundException('Família não encontrada');
    return familia;
  }

  /** Família que ficou sem ninguém não tem por que continuar na lista */
  private async apagarSeVazia(familyId: string | null) {
    if (!familyId) return;
    const restantes = await this.prisma.user.count({ where: { familyId } });
    if (!restantes) {
      await this.prisma.family.delete({ where: { id: familyId } });
    }
  }

  private async apagarVazias(familyIds: string[]) {
    for (const id of familyIds) await this.apagarSeVazia(id);
  }
}
