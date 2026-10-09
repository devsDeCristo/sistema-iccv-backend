import { BadRequestException } from '@nestjs/common';
import { proximaExecucao, validarAgendamento } from './agendamento';

/** horário de Brasília → instante UTC */
const brt = (iso: string) => new Date(`${iso}-03:00`);

// 06/10/2026 é uma terça-feira
const TERCA = 2;
const QUINTA = 4;

describe('proximaExecucao — semanal', () => {
  const todaTercaAs12 = {
    kind: 'WEEKLY' as const,
    weekdays: [TERCA],
    time: '12:00',
  };

  it('terça de manhã: dispara hoje ao meio-dia', () => {
    expect(proximaExecucao(todaTercaAs12, brt('2026-10-06T09:00'))).toEqual(
      brt('2026-10-06T12:00'),
    );
  });

  it('terça depois do meio-dia: só na terça seguinte', () => {
    expect(proximaExecucao(todaTercaAs12, brt('2026-10-06T12:00'))).toEqual(
      brt('2026-10-13T12:00'),
    );
  });

  it('o dia é o de Brasília, não o de UTC', () => {
    // segunda 22h em Brasília já é terça 01h em UTC: ainda não é terça aqui
    const tercaAs0030 = { ...todaTercaAs12, time: '00:30' };
    expect(proximaExecucao(tercaAs0030, brt('2026-10-05T22:00'))).toEqual(
      brt('2026-10-06T00:30'),
    );
  });

  it('vários dias: pega o mais próximo', () => {
    const tercaEQuinta = { ...todaTercaAs12, weekdays: [TERCA, QUINTA] };
    expect(proximaExecucao(tercaEQuinta, brt('2026-10-06T13:00'))).toEqual(
      brt('2026-10-08T12:00'),
    );
  });
});

describe('proximaExecucao — uma vez', () => {
  const sexta19h = { kind: 'ONCE' as const, runAt: brt('2026-10-09T19:00') };

  it('antes da hora: é a própria hora', () => {
    expect(proximaExecucao(sexta19h, brt('2026-10-09T10:00'))).toEqual(
      brt('2026-10-09T19:00'),
    );
  });

  it('depois de disparar: não há próxima', () => {
    expect(proximaExecucao(sexta19h, brt('2026-10-09T19:00'))).toBeNull();
  });
});

describe('validarAgendamento', () => {
  const agora = brt('2026-10-06T09:00');

  it('semanal já sai com o próximo disparo calculado', () => {
    expect(
      validarAgendamento(
        { kind: 'WEEKLY', weekdays: [TERCA, TERCA], time: '12:00' },
        agora,
      ),
    ).toMatchObject({ weekdays: [TERCA], nextRunAt: brt('2026-10-06T12:00') });
  });

  it.each([
    [{ kind: 'ONCE' as const, runAt: brt('2026-10-06T08:00') }],
    [{ kind: 'ONCE' as const }],
    [{ kind: 'WEEKLY' as const, weekdays: [], time: '12:00' }],
    [{ kind: 'WEEKLY' as const, weekdays: [7], time: '12:00' }],
    [{ kind: 'WEEKLY' as const, weekdays: [TERCA], time: '24:00' }],
  ])('recusa agendamento inválido: %j', (entrada) => {
    expect(() => validarAgendamento(entrada, agora)).toThrow(
      BadRequestException,
    );
  });
});
