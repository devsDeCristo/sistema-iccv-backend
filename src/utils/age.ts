/**
 * Idade completa (anos) que `birthday` tem em `atDate`. Não usa a data atual
 * como padrão de propósito: quem chama decide se a base é "hoje" (cadastro do
 * usuário) ou a data de um evento (elegibilidade de menor de idade para
 * aquela inscrição) — ver `MinorApprovalStatus`.
 */
export function calculateAge(birthday: Date, atDate: Date): number {
  let age = atDate.getFullYear() - birthday.getFullYear();
  const beforeBirthdayThisYear =
    atDate.getMonth() < birthday.getMonth() ||
    (atDate.getMonth() === birthday.getMonth() &&
      atDate.getDate() < birthday.getDate());

  if (beforeBirthdayThisYear) age -= 1;

  return age;
}
