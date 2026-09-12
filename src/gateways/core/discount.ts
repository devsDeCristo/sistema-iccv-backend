import { HostedCheckoutItem } from './gateway.types';

/**
 * Espalha o desconto pelos itens do carrinho.
 *
 * O PagBank tem campo próprio de desconto (`discount_amount`); Mercado Pago,
 * InfinitePay e Pagar.me não têm — para elas o total é a soma dos itens, e
 * ponto. Mandar um item de valor negativo para representar o abatimento é
 * recusado pelas três, então o abatimento tem que entrar no preço.
 *
 * Proporcional e não "tudo no primeiro item" porque o inscrito lê essa lista
 * na tela de pagamento: um ingresso a R$ 0,01 e outro cheio descrevem mal o que
 * ele está comprando.
 *
 * A sobra do arredondamento vai para o item de maior valor — é onde um centavo
 * a mais ou a menos desaparece sem distorcer nada —, e nenhum item desce
 * abaixo de um centavo por unidade, que é o mínimo que as três aceitam.
 */
export function aplicarDesconto(
  items: HostedCheckoutItem[],
  descontoEmCentavos: number,
): HostedCheckoutItem[] {
  const desconto = Math.round(descontoEmCentavos);
  if (desconto <= 0 || items.length === 0) return items;

  const linha = (item: HostedCheckoutItem) =>
    item.unitAmountCents * item.quantity;

  const total = items.reduce((soma, item) => soma + linha(item), 0);
  if (total <= 0) return items;

  // O piso: um centavo por unidade de cada item. Um desconto maior que o
  // carrinho (dois cumulativos, um percentual mal cadastrado) não pode virar
  // preço negativo nem cobrança de zero.
  const piso = items.reduce((soma, item) => soma + item.quantity, 0);
  const alvo = Math.max(piso, total - desconto);

  const fator = alvo / total;

  const ajustados = items.map((item) => ({
    ...item,
    unitAmountCents: Math.max(1, Math.round(item.unitAmountCents * fator)),
  }));

  const sobra = alvo - ajustados.reduce((soma, item) => soma + linha(item), 0);

  if (sobra !== 0) {
    const maior = ajustados.reduce((a, b) => (linha(a) >= linha(b) ? a : b));
    const porUnidade = Math.trunc(sobra / maior.quantity);
    maior.unitAmountCents = Math.max(1, maior.unitAmountCents + porUnidade);
  }

  return ajustados;
}

/** Soma do carrinho em centavos — o que as casas chamam de total do pedido */
export function totalEmCentavos(items: HostedCheckoutItem[]): number {
  return items.reduce(
    (soma, item) => soma + item.unitAmountCents * item.quantity,
    0,
  );
}

/**
 * Quanto o inscrito vai pagar de fato, já com o desconto abatido.
 *
 * Guardado no checkout para que a baixa possa conferir o valor que voltou. Sem
 * esse número, "foi pago" é uma resposta de sim ou não, e uma cobrança de
 * R$ 300 quitada com R$ 0,01 entra como paga.
 *
 * Passa pelo mesmo `aplicarDesconto` em vez de subtrair na mão porque é ele que
 * define o piso e o arredondamento — a conta tem que dar o mesmo número que
 * foi enviado para a casa, e não um parecido.
 */
export function totalCobradoEmCentavos(
  items: HostedCheckoutItem[],
  descontoEmCentavos: number,
): number {
  return totalEmCentavos(aplicarDesconto(items, descontoEmCentavos));
}
