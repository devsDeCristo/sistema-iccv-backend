import { BadRequestException } from '@nestjs/common';
import { NewsScheduleKind } from '@prisma/client';

/**
 * Calendário dos agendamentos de disparo de notícia.
 *
 * O horário que o admin escolhe ("terça às 12h") é de Brasília, e o servidor
 * não pode depender do fuso do container para entender isso: a conta é feita
 * aqui, com o fuso explícito.
 *
 * ponytail: fuso fixo em -03:00 — o Brasil não tem horário de verão desde 2019.
 * Se voltar a ter, trocar por um cálculo com `Intl`/tzdata.
 */
const FUSO_MS = -3 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Quantos agendamentos uma notícia pode ter — mais que isso é engano */
export const MAXIMO_DE_AGENDAMENTOS = 20;

/**
 * Passou disto da hora marcada sem disparar (servidor fora do ar), o disparo é
 * pulado e o agendamento segue para a próxima vez: "terça às 12h" chegando na
 * quinta confunde mais do que ajuda.
 */
export const TOLERANCIA_DE_ATRASO_MS = 60 * 60 * 1000;

export type Agendamento = {
  kind: NewsScheduleKind;
  runAt?: Date | null;
  weekdays?: number[];
  time?: string | null;
};

const HORARIO = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Próximo disparo estritamente depois de `depoisDe`, ou `null` quando não há
 * mais nenhum (o "uma vez" que já passou).
 */
export function proximaExecucao(
  agendamento: Agendamento,
  depoisDe: Date,
): Date | null {
  if (agendamento.kind === NewsScheduleKind.ONCE) {
    const quando = agendamento.runAt;
    return quando && quando.getTime() > depoisDe.getTime() ? quando : null;
  }

  const [hora, minuto] = (agendamento.time ?? '').split(':').map(Number);
  const dias = agendamento.weekdays ?? [];

  // meia-noite de hoje em Brasília, expressa em UTC
  const agoraLocal = depoisDe.getTime() + FUSO_MS;
  const inicioDoDia = agoraLocal - (agoraLocal % DIA_MS) - FUSO_MS;

  // hoje e os próximos 7 dias: o dia da semana de hoje pode já ter passado
  for (let d = 0; d <= 7; d++) {
    const dia = inicioDoDia + d * DIA_MS;
    const candidato = new Date(dia + (hora * 60 + minuto) * 60 * 1000);
    const diaDaSemana = new Date(dia - FUSO_MS).getUTCDay();

    if (
      dias.includes(diaDaSemana) &&
      candidato.getTime() > depoisDe.getTime()
    ) {
      return candidato;
    }
  }

  return null;
}

/** Confere o que veio do formulário e devolve pronto para gravar. */
export function validarAgendamento(entrada: Agendamento, agora: Date) {
  if (entrada.kind === NewsScheduleKind.ONCE) {
    const runAt = entrada.runAt ? new Date(entrada.runAt) : null;

    if (!runAt || Number.isNaN(runAt.getTime())) {
      throw new BadRequestException('Informe a data e a hora do disparo.');
    }
    if (runAt.getTime() <= agora.getTime()) {
      throw new BadRequestException(
        'O disparo agendado precisa ser numa data futura.',
      );
    }

    return {
      kind: entrada.kind,
      runAt,
      weekdays: [],
      time: null,
      nextRunAt: runAt,
    };
  }

  if (entrada.kind === NewsScheduleKind.WEEKLY) {
    const weekdays = [...new Set(entrada.weekdays ?? [])].sort();

    if (
      !weekdays.length ||
      weekdays.some((dia) => !Number.isInteger(dia) || dia < 0 || dia > 6)
    ) {
      throw new BadRequestException(
        'Escolha ao menos um dia da semana para o disparo semanal.',
      );
    }
    if (!entrada.time || !HORARIO.test(entrada.time)) {
      throw new BadRequestException(
        'Informe o horário do disparo semanal (HH:mm).',
      );
    }

    const pronto = { kind: entrada.kind, weekdays, time: entrada.time };

    return {
      ...pronto,
      runAt: null,
      nextRunAt: proximaExecucao(pronto, agora),
    };
  }

  throw new BadRequestException('Tipo de agendamento inválido.');
}
