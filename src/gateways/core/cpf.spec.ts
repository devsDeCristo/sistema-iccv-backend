import { BadRequestException } from '@nestjs/common';
import { cpfValido, exigirCpf } from './cpf';

describe('CPF', () => {
  it('confere os dígitos verificadores, com ou sem máscara', () => {
    expect(cpfValido('529.982.247-25')).toBe(true);
    expect(cpfValido('10647111114')).toBe(false); // o exemplo do Swagger
    expect(cpfValido('52998224724')).toBe(false);
    expect(cpfValido('11111111111')).toBe(false);
    expect(cpfValido('5299822472')).toBe(false);
    expect(cpfValido(null)).toBe(false);
  });

  it('exigir devolve só os dígitos, ou 400 com o que corrigir', () => {
    expect(exigirCpf('529.982.247-25')).toBe('52998224725');
    expect(() => exigirCpf('12345678900')).toThrow(BadRequestException);
  });
});
