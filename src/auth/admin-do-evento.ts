import { SetMetadata } from '@nestjs/common';
import { PrismaService } from '../prisma';
import { VINCULO_VALE } from './tenant';
import { SELECT_MODULOS } from '../planos/modulos';

/**
 * Admin de evento: quem administra um evento sem ser admin da igreja dele
 * (`EventAdmin`). Dentro do evento vale como o admin da igreja — tudo, menos
 * apagar (rota só de dev) —; fora dele, só edita o perfil dos membros da
 * igreja do evento. Não vê a tesouraria. Como o tesoureiro(a) de evento, o
 * vínculo não muda o perfil: quem é só admin de evento continua usuário comum.
 *
 * A rota diz que o aceita: `@AceitaAdminDoEvento()` deixa o `RolesGuard`
 * passar quem tem algum vínculo, **se a rota aceita admin**; o
 * `EventTenantGuard` (ou o `ChurchTenantGuard`) cobra que seja deste evento
 * (ou de um evento desta igreja).
 */
export const ACEITA_ADMIN_DO_EVENTO_KEY = 'aceitaAdminDoEvento';

export const AceitaAdminDoEvento = () =>
  SetMetadata(ACEITA_ADMIN_DO_EVENTO_KEY, true);

/** Como o vínculo de igreja, o de evento de igreja desativada não vale */
const DE_IGREJA_QUE_VALE = { event: VINCULO_VALE };

/** É admin de algum evento (de igreja que vale)? */
export async function temVinculoDeAdminDeEvento(
  prisma: PrismaService,
  userId: string,
): Promise<boolean> {
  const vinculo = await prisma.eventAdmin.findFirst({
    where: { userId, ...DE_IGREJA_QUE_VALE },
    select: { eventId: true },
  });
  return !!vinculo;
}

/** É admin deste evento? */
export async function adminDoEvento(
  prisma: PrismaService,
  userId: string,
  eventId: string,
): Promise<boolean> {
  const vinculo = await prisma.eventAdmin.findFirst({
    where: { userId, eventId, ...DE_IGREJA_QUE_VALE },
    select: { eventId: true },
  });
  return !!vinculo;
}

/** É admin de algum evento desta igreja? Abre a lista de membros dela. */
export async function adminDeEventoNaIgreja(
  prisma: PrismaService,
  userId: string,
  churchId: string,
): Promise<boolean> {
  const vinculo = await prisma.eventAdmin.findFirst({
    where: { userId, event: { churchId, ...VINCULO_VALE } },
    select: { eventId: true },
  });
  return !!vinculo;
}

/** Os eventos de que a pessoa é admin (de igreja que vale) */
export async function eventosDoAdmin(prisma: PrismaService, userId: string) {
  return prisma.eventAdmin.findMany({
    where: { userId, ...DE_IGREJA_QUE_VALE },
    select: {
      event: {
        select: {
          id: true,
          name: true,
          churchId: true,
          church: { select: { name: true, ...SELECT_MODULOS } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * O alcance do admin de evento sobre as pessoas: os eventos dele e as igrejas
 * desses eventos (os membros dela). Vazio para quem não é admin de evento.
 */
export async function alcanceDoAdminDeEvento(
  prisma: PrismaService,
  userId: string,
) {
  const vinculos = await eventosDoAdmin(prisma, userId);
  return {
    eventIds: vinculos.map((v) => v.event.id),
    churchIds: [...new Set(vinculos.map((v) => v.event.churchId))],
  };
}
