import { SetMetadata } from '@nestjs/common';
import { EventTreasurerKind } from '@prisma/client';
import { PrismaService } from '../prisma';
import { VINCULO_VALE } from './tenant';

/**
 * Tesoureiro(a) de evento: quem cuida da tesouraria de um evento sem ser admin
 * nem tesouraria da igreja (`EventTreasurer`). O vínculo é por evento — a
 * pessoa é tesoureira de um e não de outro — e não muda o perfil dela: quem é
 * só tesoureiro de evento continua usuário comum.
 *
 * Por isso a rota precisa dizer que o aceita. `@AceitaTesoureiroDoEvento()`
 * deixa o `RolesGuard` passar quem tem algum vínculo de tesoureiro, e o
 * `EventTenantGuard` cobra o resto: o vínculo tem de ser **deste** evento.
 * Rota sem o decorator continua fechada para ele, como sempre foi.
 */
export const ACEITA_TESOUREIRO_KEY = 'aceitaTesoureiroDoEvento';

export const AceitaTesoureiroDoEvento = () =>
  SetMetadata(ACEITA_TESOUREIRO_KEY, true);

/** Como o vínculo de igreja, o de evento de igreja desativada não vale */
const DE_IGREJA_QUE_VALE = { event: VINCULO_VALE };

/** É tesoureiro(a) de algum evento (de igreja que vale)? */
export async function temVinculoDeTesoureiro(
  prisma: PrismaService,
  userId: string,
): Promise<boolean> {
  const vinculo = await prisma.eventTreasurer.findFirst({
    where: { userId, ...DE_IGREJA_QUE_VALE },
    select: { eventId: true },
  });
  return !!vinculo;
}

/** O tipo do vínculo da pessoa neste evento, ou `null` se não é tesoureira */
export async function tesoureiroDoEvento(
  prisma: PrismaService,
  userId: string,
  eventId: string,
): Promise<EventTreasurerKind | null> {
  const vinculo = await prisma.eventTreasurer.findFirst({
    where: { userId, eventId, ...DE_IGREJA_QUE_VALE },
    select: { kind: true },
  });
  return vinculo?.kind ?? null;
}

/** Os eventos (de igreja que vale) em que a pessoa é tesoureira */
export async function eventosDoTesoureiro(
  prisma: PrismaService,
  userId: string,
) {
  return prisma.eventTreasurer.findMany({
    where: { userId, ...DE_IGREJA_QUE_VALE },
    select: {
      kind: true,
      event: { select: { id: true, name: true, churchId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}
