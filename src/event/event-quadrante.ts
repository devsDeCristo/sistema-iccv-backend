import { moduloAtivo } from './event-modules';

/**
 * Se os inscritos do evento podem abrir o quadrante.
 *
 * Mora em `Event.data.showQuadrante`. Diferente dos módulos, **ausente é
 * desligado**: o quadrante traz e-mail, celular e data de nascimento de toda a
 * equipe, e nenhum evento que já existe mostrava isso para os inscritos. Abrir
 * esses dados é decisão de quem organiza, nunca efeito de subir código.
 *
 * Sem o módulo de equipes não há quadrante para mostrar, então a chave ligada
 * com o módulo desligado vale como desligada.
 */
export function quadranteVisivelParaInscritos(data: unknown): boolean {
  const valor = (data as { showQuadrante?: unknown } | null)?.showQuadrante;

  return valor === true && moduloAtivo(data, 'teams');
}

/** Só `true` liga: `'sim'` ou `1` vindos do corpo não abrem dado de ninguém. */
export function normalizarMostrarQuadrante(valor: unknown): boolean {
  return valor === true;
}
