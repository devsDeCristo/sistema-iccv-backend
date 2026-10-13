import { ForbiddenException, SetMetadata } from '@nestjs/common';
import { ChurchModule, PrismaClient } from '@prisma/client';

/** Como cada módulo aparece nas mensagens (a tela tem os mesmos rótulos) */
export const ROTULO_DO_MODULO: Record<ChurchModule, string> = {
  EVENTS: 'Eventos',
  NEWS: 'Notícias',
  TREASURY: 'Tesouraria',
};

/**
 * O que ler da igreja para saber os módulos dela (e se a cobrança online, que
 * é parte de Eventos, está ligada nela)
 */
export const SELECT_MODULOS = {
  plan: { select: { modules: true } },
  modulePayment: true,
} as const;

/** Os módulos da igreja: os do plano dela; sem plano, nenhum */
export const modulosDa = (
  igreja: { plan?: { modules: ChurchModule[] } | null } | null | undefined,
): ChurchModule[] => igreja?.plan?.modules ?? [];

/**
 * A igreja cobra online? Precisa do módulo Eventos no plano — dar às igrejas o
 * suporte a pagamentos é parte do que o módulo de eventos é — **e** da cobrança
 * ligada nela (`Church.modulePayment`, que o dev/super admin desliga por
 * igreja). Ausente conta como ligada.
 */
export const cobraOnline = (
  igreja:
    | { plan?: { modules: ChurchModule[] } | null; modulePayment?: boolean }
    | null
    | undefined,
) =>
  modulosDa(igreja).includes(ChurchModule.EVENTS) &&
  igreja?.modulePayment !== false;

/**
 * Igreja que não cobra online: sem plano, com um plano sem Eventos, ou com a
 * cobrança desligada. Para o `where` das consultas (reconciliação, cron).
 */
export const SEM_COBRANCA_ONLINE = {
  OR: [
    { planId: null },
    { plan: { NOT: { modules: { has: ChurchModule.EVENTS } } } },
    { modulePayment: false },
  ],
};

/**
 * Recusa (403) se o plano da igreja não tem o módulo. Igreja que não existe
 * passa: quem responde 404 é o service.
 */
export async function exigirModulo(
  prisma: Pick<PrismaClient, 'church'>,
  churchId: string,
  modulo: ChurchModule,
) {
  const igreja = await prisma.church.findUnique({
    where: { id: churchId },
    select: { name: true, ...SELECT_MODULOS },
  });
  if (igreja && !modulosDa(igreja).includes(modulo)) {
    throw new ForbiddenException(
      `O plano de ${igreja.name} não inclui o módulo ${ROTULO_DO_MODULO[modulo]}`,
    );
  }
}

export const MODULO_KEY = 'modulo';

/**
 * O módulo do plano que a rota exige (na classe ou no método). Quem cobra é o
 * `ModuloGuard`, no fim do `@UseGuards` do controller.
 */
export const Modulo = (modulo: ChurchModule) => SetMetadata(MODULO_KEY, modulo);
