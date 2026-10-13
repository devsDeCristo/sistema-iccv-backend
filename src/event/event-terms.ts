import { Prisma } from '@prisma/client';

/**
 * O termo do evento vive em `data.registrationTerm`, em HTML, escrito pelo
 * admin no editor da etapa de termos. Ter termo é o que faz a inscrição exigir
 * aceite — então "vazio" precisa ser reconhecido aqui, e não só na tela.
 *
 * Vazio no editor não é string vazia: uma caixa em que se digitou e se apagou
 * volta como `<p><br></p>`. Sem tratar isso, todo evento que passou pela etapa
 * de termos passaria a exigir aceite, inclusive os que não têm termo nenhum.
 */
export function termoDeInscricao(data: Prisma.JsonValue | null | undefined) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';

  const termo = (data as Prisma.JsonObject)['registrationTerm'];

  return typeof termo === 'string' ? termo : '';
}

/** Se este evento recusa inscrição sem aceite do termo. */
export function exigeAceiteDeTermo(
  data: Prisma.JsonValue | null | undefined,
): boolean {
  const termo = termoDeInscricao(data);

  if (!termo) return false;

  // termo escrito como imagem continua sendo termo, mesmo sem texto
  if (/<(img|iframe|video)\b/i.test(termo)) return true;

  return (
    termo
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim().length > 0
  );
}

/**
 * Até que idade o evento exige o termo de autorização dos pais: 16 ou 18, um
 * switch no cadastro do evento (`data.minorAgeLimit`). Ausente é 16, a regra
 * de antes do switch — os eventos que já existem não mudam. A idade é a que a
 * pessoa terá no primeiro dia do evento.
 */
export function idadeDoTermo(
  data: Prisma.JsonValue | null | undefined,
): 16 | 18 {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 16;

  return (data as Prisma.JsonObject)['minorAgeLimit'] === 18 ? 18 : 16;
}
