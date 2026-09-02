import { EventStatus } from '@prisma/client';
import { Role } from 'src/auth/roles';
import {
  TenantRequester,
  churchIdsComPerfil,
  isSuperAdmin,
  perfilNaIgreja,
} from 'src/auth/tenant';

/**
 * Quem enxerga evento em teste.
 *
 * Evento em teste é ensaio de configuração: só faz sentido para quem
 * **administra** aquela igreja. A pergunta é por igreja e não pelo perfil
 * efetivo — quem é admin numa igreja e financeiro em outra tem perfil efetivo
 * de admin, e decidir por ele mostrava a ela os ensaios da igreja onde ela só
 * cuida do financeiro.
 *
 * Vale igual no painel e no catálogo: no painel a lista já vem recortada pelas
 * igrejas da pessoa, e aqui os ensaios das que ela não administra saem fora.
 */
export function filtroDeEventoEmTeste(requester?: TenantRequester | null) {
  // o super admin atravessa todas as igrejas, ensaios inclusive
  if (isSuperAdmin(requester)) return {};

  const igrejasQueAdministra = churchIdsComPerfil(requester, [Role.ADMIN]);

  // inscrito e financeiro puro não administram nada: nenhum ensaio para eles
  if (igrejasQueAdministra.length === 0) {
    return { status: { not: EventStatus.TEST } };
  }

  return {
    OR: [
      { status: { not: EventStatus.TEST } },
      { churchId: { in: igrejasQueAdministra } },
    ],
  };
}

/**
 * Se esta pessoa enxerga o ensaio de uma igreja em particular.
 *
 * A versão pontual de `filtroDeEventoEmTeste`, para quando já se sabe de qual
 * evento se trata. Mesma regra: administrar aquela igreja, e não ter perfil
 * efetivo de admin por causa de outra.
 */
export function podeVerEventoEmTeste(
  requester: TenantRequester | null | undefined,
  churchId: string,
): boolean {
  if (isSuperAdmin(requester)) return true;

  return perfilNaIgreja(requester, churchId) === Role.ADMIN;
}
