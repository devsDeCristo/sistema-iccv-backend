import { BadRequestException } from '@nestjs/common';

/**
 * CPF com os dígitos verificadores certos.
 *
 * O cadastro só confere o tamanho (11), e o gateway confere os dígitos: um
 * CPF digitado errado passava por aqui e voltava como "não foi possível falar
 * com o gateway", sem dizer à pessoa o que corrigir.
 */
export function cpfValido(cpf: string | null | undefined): boolean {
  const d = (cpf ?? '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;

  const digito = (ate: number) => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

/** Para cobrança que não sai sem CPF (Pix por order, Ton): 400 com o que corrigir */
export function exigirCpf(cpf: string): string {
  if (!cpfValido(cpf)) {
    throw new BadRequestException(
      'CPF do cadastro inválido: corrija o seu perfil para pagar.',
    );
  }
  return cpf.replace(/\D/g, '');
}
