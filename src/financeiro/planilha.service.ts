import { ConflictException, Injectable } from '@nestjs/common';
import {
  FinancialCategory,
  FinancialEntrySource,
  FinancialEntryType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembrosService, cpfMascarado } from 'src/membros/membros.service';
import { paraDia } from './dizimistas.service';
import {
  emComum,
  escolher,
  normalizar,
  palavrasDaBusca,
  palavrasDoNome,
} from './planilha';
import { LinhaDaPlanilhaDto } from './dto/financeiro.dto';

const COM_ACENTO = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucn';

const CANDIDATO = {
  id: true,
  fullName: true,
  cpf: true,
  profilePhotoUrl: true,
  memberChurchId: true,
  memberChurch: { select: { id: true, name: true } },
} as const;

/**
 * Importação da planilha de dízimos: uma linha por pessoa, com o total de
 * cada mês do ano. A tela lê o arquivo e manda os nomes; aqui se descobre quem
 * é cada um (`previa`) e, confirmado pela pessoa, cada mês com valor vira um
 * lançamento de dízimo ligado ao dizimista, que vira membro desta igreja se
 * ainda não era (`importar`).
 *
 * Só o admin da igreja: a importação coloca gente como membro, e isso é dele.
 */
@Injectable()
export class PlanilhaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membros: MembrosService,
  ) {}

  /**
   * Para cada nome, os candidatos (os membros desta igreja com o mesmo nome e
   * a busca no sistema todo) e quem o sistema escolheria. Os candidatos voltam
   * como na busca de Membros: CPF pela metade e de qual igreja já são membros.
   */
  async previa(churchId: string, nomes: string[]) {
    const daqui = await this.prisma.user.findMany({
      where: { memberChurchId: churchId },
      select: CANDIDATO,
    });

    const linhas = [];
    // um nome por vez: a planilha tem algumas centenas, e o pool agradece
    for (const nome of nomes) {
      const alvo = palavrasDoNome(nome).join(' ');
      const achados = await this.buscar(nome);
      const candidatos = [
        ...daqui.filter((m) => palavrasDoNome(m.fullName).join(' ') === alvo),
        ...achados,
      ]
        .filter((c, i, todos) => todos.findIndex((o) => o.id === c.id) === i)
        // quem tem mais palavras em comum primeiro
        .sort((a, b) => emComum(nome, b.fullName) - emComum(nome, a.fullName));

      linhas.push({
        nome,
        ...escolher(nome, candidatos, churchId),
        candidatos: candidatos.map((c) => ({
          id: c.id,
          fullName: c.fullName,
          cpf: cpfMascarado(c.cpf),
          profilePhotoUrl: c.profilePhotoUrl,
          membroDe: c.memberChurch,
        })),
      });
    }
    return linhas;
  }

  /**
   * Quem tem 2+ palavras do nome em comum, palavra inteira e ignorando acento
   * dos dois lados ("Miqueias" acha "Miquéias"; "ana" não acha "Mariana"), os
   * com mais palavras em comum primeiro. O Prisma não ignora acento (e o
   * `unaccent` não está instalado), daí o SQL: `translate` tira o acento e
   * `\m...\M` é o limite de palavra do Postgres. As palavras já vêm só com
   * letras e números, sem nada que a expressão regular interprete.
   *
   * ponytail: varre a tabela de usuários a cada nome; com muitos milhares de
   * usuários, um índice de trigramas sobre o nome sem acento.
   */
  private async buscar(nome: string) {
    const palavras = palavrasDaBusca(nome);
    if (!palavras) return [];
    const acertos = Prisma.join(
      palavras.map(
        (p) =>
          Prisma.sql`(translate(lower("fullName"), ${COM_ACENTO}, ${SEM_ACENTO}) ~ ${`\\m${p}\\M`})::int`,
      ),
      ' + ',
    );
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "users"
      WHERE ${acertos} >= 2
      ORDER BY ${acertos} DESC
      LIMIT 8`;
    return this.prisma.user.findMany({
      where: { id: { in: ids.map((i) => i.id) } },
      select: CANDIDATO,
    });
  }

  /**
   * Grava as linhas confirmadas. Cada mês com valor vira um dízimo no dia 1º
   * do mês. Sem `userId`, a linha é **sem vínculo**: quem não é usuário do
   * sistema (ou a linha "Anônimo"); o dízimo entra sem dizimista, com o nome da
   * planilha na descrição e no pagador.
   *
   * Importar de novo não duplica: o `externalId` é a pessoa e o mês. O mês
   * já importado fica como está, mesmo que o valor tenha mudado na planilha —
   * corrige-se no lançamento.
   */
  async importar(
    churchId: string,
    ano: number,
    linhas: LinhaDaPlanilhaDto[],
    actorId?: string,
  ) {
    const ids = [...new Set(linhas.map((l) => l.userId).filter(Boolean))];
    const pessoas = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: ids as string[] } },
          select: { id: true, memberChurchId: true },
        })
      ).map((p) => [p.id, p]),
    );

    const ignorados: { nome: string; motivo: string }[] = [];
    let novosMembros = 0;
    // pela chave: a mesma pessoa em duas linhas soma no mês
    const porChave = new Map<string, Prisma.FinancialEntryCreateManyInput>();

    for (const linha of linhas) {
      const pessoa = linha.userId ? pessoas.get(linha.userId) : null;
      if (linha.userId && !pessoa) {
        ignorados.push({ nome: linha.nome, motivo: 'Pessoa não encontrada' });
        continue;
      }
      if (pessoa && pessoa.memberChurchId !== churchId) {
        if (pessoa.memberChurchId) {
          ignorados.push({
            nome: linha.nome,
            motivo: 'Já é membro de outra igreja',
          });
          continue;
        }
        try {
          await this.membros.tornarMembro(churchId, pessoa.id);
        } catch (erro) {
          // entrou em outra igreja entre a leitura e aqui
          if (!(erro instanceof ConflictException)) throw erro;
          ignorados.push({
            nome: linha.nome,
            motivo: 'Já é membro de outra igreja',
          });
          continue;
        }
        pessoa.memberChurchId = churchId;
        novosMembros++;
      }

      // "anonimo:" é a chave da linha sem vínculo desde a primeira versão: mudar
      // duplicaria o que já foi importado
      const quem = pessoa ? pessoa.id : `anonimo:${normalizar(linha.nome)}`;
      linha.valores.forEach((valor, i) => {
        if (!valor) return;
        const mes = String(i + 1).padStart(2, '0');
        const chave = `planilha:${quem}:${ano}-${mes}`;
        const anterior = porChave.get(chave);
        if (anterior) {
          anterior.amount =
            Math.round((Number(anterior.amount) + valor) * 100) / 100;
          return;
        }
        porChave.set(chave, {
          churchId,
          type: FinancialEntryType.INCOME,
          category: FinancialCategory.TITHE,
          amount: valor,
          date: paraDia(`${ano}-${mes}-01`),
          description: `Dízimo ${mes}/${ano} — ${linha.nome} (planilha)`,
          userId: pessoa?.id ?? null,
          source: FinancialEntrySource.MANUAL,
          externalId: chave,
          payerName: linha.nome,
          createdById: actorId ?? null,
          updatedById: actorId ?? null,
        });
      });
    }

    const dados = [...porChave.values()];
    const { count } = await this.prisma.financialEntry.createMany({
      data: dados,
      skipDuplicates: true,
    });

    return {
      lancamentos: count,
      jaExistiam: dados.length - count,
      novosMembros,
      ignorados,
    };
  }
}
