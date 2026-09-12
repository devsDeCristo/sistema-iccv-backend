import { aplicarDesconto, totalEmCentavos } from './discount';
import { HostedCheckoutItem } from './gateway.types';

const item = (
  referenceId: string,
  unitAmountCents: number,
  quantity = 1,
): HostedCheckoutItem => ({
  referenceId,
  name: referenceId,
  description: referenceId,
  quantity,
  unitAmountCents,
});

/**
 * Três das quatro casas não têm campo de desconto: o abatimento vira preço.
 * Errar a conta aqui é cobrar a mais ou a menos de quem se inscreveu, então o
 * que estes testes cobram é o total exato — não uma aproximação.
 */
describe('aplicarDesconto', () => {
  it('não mexe em nada quando não há desconto', () => {
    const itens = [item('a', 10000), item('b', 5000)];

    expect(aplicarDesconto(itens, 0)).toEqual(itens);
    expect(aplicarDesconto(itens, -50)).toEqual(itens);
  });

  it('chega no total exato, sem sobra de arredondamento', () => {
    const itens = [item('a', 10000), item('b', 5000)];

    const comDesconto = aplicarDesconto(itens, 3000);

    expect(totalEmCentavos(comDesconto)).toBe(12000);
  });

  it('reparte proporcionalmente em vez de zerar o primeiro item', () => {
    const itens = [item('a', 10000), item('b', 5000)];

    const [a, b] = aplicarDesconto(itens, 3000);

    // 20% de abatimento em cada, e não "tudo no primeiro": o inscrito lê essa
    // lista na tela de pagamento.
    expect(a.unitAmountCents).toBe(8000);
    expect(b.unitAmountCents).toBe(4000);
  });

  it('fecha a conta mesmo quando a proporção não é redonda', () => {
    const itens = [item('a', 3333), item('b', 3333), item('c', 3334)];

    const comDesconto = aplicarDesconto(itens, 1000);

    expect(totalEmCentavos(comDesconto)).toBe(9000);
    comDesconto.forEach((i) => expect(i.unitAmountCents).toBeGreaterThan(0));
  });

  it('respeita a quantidade maior que um', () => {
    const itens = [item('a', 5000, 2), item('b', 10000)];

    const comDesconto = aplicarDesconto(itens, 4000);

    expect(totalEmCentavos(comDesconto)).toBe(16000);
  });

  it('não deixa o preço chegar a zero quando o desconto passa do carrinho', () => {
    const itens = [item('a', 10000), item('b', 5000)];

    // Dois descontos cumulativos ou um percentual mal cadastrado chegam aqui.
    // Preço zero (ou negativo) é recusado pelas três casas, e o checkout
    // inteiro falharia sem dizer por quê.
    const comDesconto = aplicarDesconto(itens, 99999);

    expect(totalEmCentavos(comDesconto)).toBe(2);
    comDesconto.forEach((i) => expect(i.unitAmountCents).toBe(1));
  });

  it('não quebra com carrinho vazio', () => {
    expect(aplicarDesconto([], 500)).toEqual([]);
  });
});
