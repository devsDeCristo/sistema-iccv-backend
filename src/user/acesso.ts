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
