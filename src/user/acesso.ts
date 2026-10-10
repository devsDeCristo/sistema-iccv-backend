/**
 * O acesso da conta é o par CPF (login) + e-mail (para onde vai o código de
 * "esqueci a senha"). Trocar qualquer um dos dois é trocar quem entra.
 */
export function mudaAcesso(
  pedido: { email?: string | null; cpf?: string | null },
  atual: { email: string | null; cpf: string | null },
): boolean {
  return (
    (pedido.email !== undefined && pedido.email !== atual.email) ||
    (pedido.cpf !== undefined && pedido.cpf !== atual.cpf)
  );
}

/**
 * "fu***@gmail.com": o aviso de troca vai para o e-mail antigo, que pode já
 * não ser do dono — não precisa entregar o endereço novo inteiro.
 */
export function mascararEmail(email: string): string {
  const [nome, dominio] = email.split('@');
  if (!dominio) return '***';
  return `${nome.slice(0, 2)}***@${dominio}`;
}

/**
 * Como todo e-mail é guardado: sem espaço nas pontas e em minúsculas. A busca
 * por e-mail compara texto puro, e "Fulano@Gmail.com" e "fulano@gmail.com" são
 * a mesma caixa de entrada.
 */
export function normalizarEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const EMAIL_EM_USO =
  'Este e-mail já está em uso em outro cadastro. Use outro e-mail ou fale com a secretaria.';
