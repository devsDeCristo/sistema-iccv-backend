import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { aplicarConsentimento } from 'src/user/dados-sensiveis';
import { PublicarTermosDto } from './dto/publicar-termos.dto';

type Banco = PrismaService | Prisma.TransactionClient;

export interface ContextoDoAceite {
  ip?: string | null;
  userAgent?: string | null;
}

/** A versão que a página mostra e que o aceite registra: a mais recente */
function vigente(db: Banco) {
  return db.termsDocument.findFirst({ orderBy: { publishedAt: 'desc' } });
}

/**
 * A versão que todo mundo precisa ter aceitado: a mais recente publicada como
 * mudança relevante. Quem aceitou ela, ou qualquer uma depois dela, está em
 * dia — correção de texto publicada depois não pede aceite de novo.
 */
function exigida(db: Banco) {
  return db.termsDocument.findFirst({
    where: { requiresAcceptance: true },
    orderBy: { publishedAt: 'desc' },
  });
}

/** Grava o aceite da versão vigente. Aceitar de novo a mesma não duplica. */
export async function registrarAceite(
  db: Banco,
  userId: string,
  contexto: ContextoDoAceite,
) {
  const termos = await vigente(db);
  // sem termos publicados não há o que aceitar
  if (!termos) return;

  await db.termsAcceptance.upsert({
    where: { userId_version: { userId, version: termos.version } },
    create: {
      userId,
      version: termos.version,
      ip: contexto.ip ?? null,
      // cabeçalho longo vindo de fora: com teto, como no registro de login
      userAgent: contexto.userAgent?.slice(0, 255) ?? null,
    },
    update: {},
  });
}

/** "2026-09-24" no fuso da igreja; a segunda publicação do dia vira ".2" */
async function proximaVersao(db: Banco, agora = new Date()) {
  const dia = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
  }).format(agora);
  const doDia = await db.termsDocument.count({
    where: { version: { startsWith: dia } },
  });
  return doDia === 0 ? dia : `${dia}.${doDia + 1}`;
}

@Injectable()
export class TermsService {
  constructor(private readonly prisma: PrismaService) {}

  /** O texto vigente, para a página pública `/termos` */
  async atual() {
    const termos = await vigente(this.prisma);
    if (!termos) throw new NotFoundException('Termos de Uso não publicados');

    return {
      version: termos.version,
      content: termos.content,
      summary: termos.summary,
      publishedAt: termos.publishedAt,
    };
  }

  async status(userId: string) {
    const [atual, requerida, user] = await Promise.all([
      vigente(this.prisma),
      exigida(this.prisma),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          sensitiveConsentAt: true,
          religion: true,
          diabetes: true,
          hypertensive: true,
        },
      }),
    ]);

    // vale a exigida ou qualquer versão publicada depois dela
    const aceito = requerida
      ? (await this.prisma.termsAcceptance.count({
          where: {
            userId,
            version: {
              in: (
                await this.prisma.termsDocument.findMany({
                  where: { publishedAt: { gte: requerida.publishedAt } },
                  select: { version: true },
                })
              ).map((termos) => termos.version),
            },
          },
        })) > 0
      : true;

    const temDadosSensiveis =
      !!user &&
      (!!user.religion || user.diabetes !== null || user.hypertensive !== null);

    return {
      versao: atual?.version ?? null,
      aceito,
      consentimentoDadosSensiveis: !!user?.sensitiveConsentAt,
      /**
       * Cadastro feito antes do consentimento específico, com saúde ou
       * religião já guardados: o titular decide se autoriza ou se os dados são
       * apagados. A migração não apagou nada — a decisão é dele.
       */
      precisaDecidirDadosSensiveis:
        temDadosSensiveis && !user?.sensitiveConsentAt,
    };
  }

  /**
   * Aceite dos termos pela própria pessoa (o aviso depois do login), com a
   * decisão sobre os dados sensíveis quando ela foi pedida.
   */
  async aceitar(
    userId: string,
    contexto: ContextoDoAceite,
    consentimento?: boolean,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await registrarAceite(tx, userId, contexto);

      if (consentimento === undefined) return;

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { sensitiveConsentAt: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: aplicarConsentimento(
          {},
          consentimento,
          user?.sensitiveConsentAt ?? null,
        ),
      });
    });

    return this.status(userId);
  }

  /** O histórico, da mais recente para a mais antiga, com quantos aceitaram cada uma */
  async versoes() {
    const [lista, aceites] = await Promise.all([
      this.prisma.termsDocument.findMany({
        orderBy: { publishedAt: 'desc' },
        select: {
          id: true,
          version: true,
          summary: true,
          content: true,
          requiresAcceptance: true,
          publishedAt: true,
          publishedBy: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.termsAcceptance.groupBy({
        by: ['version'],
        _count: { _all: true },
      }),
    ]);

    return lista.map((termos) => ({
      ...termos,
      acceptances:
        aceites.find((aceite) => aceite.version === termos.version)?._count
          ._all ?? 0,
    }));
  }

  /**
   * Publica uma versão nova. Nenhuma versão anterior é alterada: é o texto que
   * alguém aceitou, e ele tem que continuar existindo como era.
   */
  async publicar(dto: PublicarTermosDto, publicadoPor: string) {
    // duas publicações no mesmo instante disputam o mesmo número de versão;
    // a que perder tenta o seguinte
    for (let tentativa = 1; ; tentativa++) {
      try {
        return await this.prisma.termsDocument.create({
          data: {
            version: await proximaVersao(this.prisma),
            content: dto.content,
            summary: dto.summary.map((frase) => frase.trim()).filter(Boolean),
            requiresAcceptance: dto.requiresAcceptance,
            publishedById: publicadoPor,
          },
          select: {
            version: true,
            publishedAt: true,
            requiresAcceptance: true,
          },
        });
      } catch (erro) {
        const conflito =
          erro instanceof Prisma.PrismaClientKnownRequestError &&
          erro.code === 'P2002';
        if (!conflito || tentativa >= 3) throw erro;
      }
    }
  }
}
