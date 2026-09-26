import { BadRequestException } from '@nestjs/common';
import {
  VarianteRecebida,
  TAMANHO_MAXIMO_DA_FOTO,
  conferirEstoque,
  disponivel,
  montarPedido,
  validarFoto,
  validarFotos,
  MAXIMO_DE_FOTOS,
  podeComprarNaLoja,
  conferirEstoqueAoReativar,
  validarProdutos,
} from './event-products';

const camisa = (variants: VarianteRecebida[] = [{ name: 'P', stock: 10 }]) => ({
  name: 'Camisa',
  price: 50,
  variants,
});

describe('validarFoto', () => {
  it('distingue não mexer, remover e trocar', () => {
    expect(validarFoto(undefined)).toBeUndefined();
    expect(validarFoto(null)).toBeNull();
    expect(validarFoto('')).toBeNull();
    expect(validarFoto('data:image/webp;base64,AAAA')).toBe(
      'data:image/webp;base64,AAAA',
    );
  });

  it('recusa o que não é imagem em base64', () => {
    // iria direto para um <img src> na tela de inscrição
    expect(() => validarFoto('javascript:alert(1)')).toThrow(
      BadRequestException,
    );
    expect(() => validarFoto('data:image/svg+xml;base64,AAAA')).toThrow(
      BadRequestException,
    );
  });

  it('recusa foto acima do teto', () => {
    const grande = `data:image/png;base64,${'A'.repeat(
      TAMANHO_MAXIMO_DA_FOTO,
    )}`;
    expect(() => validarFoto(grande)).toThrow(/grande demais/);
  });
});

describe('validarProdutos', () => {
  it('aceita produto com variante e estoque opcional', () => {
    expect(() =>
      validarProdutos([camisa([{ name: 'P', stock: 10 }, { name: 'G' }])]),
    ).not.toThrow();
  });

  it('exige pelo menos uma variante', () => {
    expect(() => validarProdutos([camisa([])])).toThrow(/pelo menos uma/);
  });

  it('recusa variante repetida sem diferenciar maiúscula', () => {
    expect(() =>
      validarProdutos([
        camisa([
          { name: 'P', stock: 1 },
          { name: ' p ', stock: 2 },
        ]),
      ]),
    ).toThrow(/duas vezes/);
  });

  it('recusa estoque negativo ou fracionado e preço negativo', () => {
    expect(() =>
      validarProdutos([camisa([{ name: 'P', stock: -1 }])]),
    ).toThrow();
    expect(() =>
      validarProdutos([camisa([{ name: 'P', stock: 1.5 }])]),
    ).toThrow();
    expect(() => validarProdutos([{ ...camisa(), price: -1 }])).toThrow();
  });
});

describe('montarPedido', () => {
  it('monta a quantidade por variante', () => {
    expect(
      montarPedido([
        { variantId: 'p', quantity: 2 },
        { variantId: 'g', quantity: 1 },
      ]),
    ).toEqual(
      new Map([
        ['p', 2],
        ['g', 1],
      ]),
    );
  });

  it('recusa pedido vazio, quantidade fora da faixa e variante repetida', () => {
    expect(() => montarPedido([])).toThrow();
    expect(() => montarPedido([{ variantId: 'p', quantity: 0 }])).toThrow();
    expect(() => montarPedido([{ variantId: 'p', quantity: 21 }])).toThrow();
    expect(() =>
      montarPedido([
        { variantId: 'p', quantity: 1 },
        { variantId: 'p', quantity: 1 },
      ]),
    ).toThrow(/duas vezes/);
  });
});

describe('conferirEstoque', () => {
  const variantes = [
    { id: 'p', name: 'P', stock: 5, productName: 'Camisa' },
    { id: 'g', name: 'G', stock: null, productName: 'Camisa' },
  ];

  it('deixa passar o que cabe e o que não tem limite', () => {
    expect(() =>
      conferirEstoque(
        variantes,
        new Map([['p', 3]]),
        new Map([
          ['p', 2],
          ['g', 500],
        ]),
      ),
    ).not.toThrow();
  });

  it('diz quanto sobrou quando o pedido passa do restante', () => {
    expect(() =>
      conferirEstoque(variantes, new Map([['p', 3]]), new Map([['p', 3]])),
    ).toThrow('Camisa (P): restam só 2 unidades');
  });

  it('diz que esgotou quando não sobrou nada', () => {
    expect(() =>
      conferirEstoque(variantes, new Map([['p', 5]]), new Map([['p', 1]])),
    ).toThrow('Camisa (P) esgotou');
  });

  it('calcula o disponível sem ficar negativo', () => {
    expect(disponivel(5, 7)).toBe(0);
    expect(disponivel(null, 7)).toBeNull();
  });
});

describe('validarFotos', () => {
  const foto = 'data:image/webp;base64,AAAA';

  it('distingue não mexer, remover todas e trocar', () => {
    expect(validarFotos(undefined)).toBeUndefined();
    expect(validarFotos(null)).toEqual([]);
    expect(validarFotos([])).toEqual([]);
    expect(validarFotos([foto, foto])).toEqual([foto, foto]);
  });

  it('aceita até 5 fotos e recusa a sexta', () => {
    expect(validarFotos(Array(MAXIMO_DE_FOTOS).fill(foto))).toHaveLength(5);
    expect(() => validarFotos(Array(MAXIMO_DE_FOTOS + 1).fill(foto))).toThrow(
      /até 5 fotos/,
    );
  });

  it('uma foto ruim no meio recusa a lista inteira', () => {
    expect(() => validarFotos([foto, 'javascript:alert(1)'])).toThrow(
      BadRequestException,
    );
  });

  it('vazias caem fora, e a ordem (capa primeiro) é mantida', () => {
    const outra = 'data:image/png;base64,BBBB';
    expect(validarFotos([outra, '', foto])).toEqual([outra, foto]);
  });
});

describe('podeComprarNaLoja', () => {
  it('restrita por padrão: só inscrito confirmado compra', () => {
    expect(podeComprarNaLoja(true, {})).toBe(true);
    expect(podeComprarNaLoja(false, {})).toBe(false);
    expect(podeComprarNaLoja(false, null)).toBe(false);
    expect(podeComprarNaLoja(false, { publicStore: false })).toBe(false);
    // só o booleano abre: um "true" em texto no JSON não conta
    expect(podeComprarNaLoja(false, { publicStore: 'true' })).toBe(false);
  });

  it('pública: qualquer pessoa com cadastro compra', () => {
    expect(podeComprarNaLoja(false, { publicStore: true })).toBe(true);
  });

  it('em nome de outra pessoa, só para inscrito — mesmo na pública', () => {
    expect(podeComprarNaLoja(false, { publicStore: true }, true)).toBe(false);
    expect(podeComprarNaLoja(true, { publicStore: true }, true)).toBe(true);
  });
});

describe('conferirEstoqueAoReativar', () => {
  // o `tx` só precisa das duas consultas que a conferência faz
  const tx = (vendidas: number, stock: number | null = 10) =>
    ({
      paymentProductItem: {
        findMany: async () => [
          {
            variantId: 'v1',
            quantity: 2,
            variant: { name: 'P', stock, product: { name: 'Camisa' } },
          },
        ],
        groupBy: async () => [
          { variantId: 'v1', _sum: { quantity: vendidas } },
        ],
      },
    } as any);

  it('recusa quando as unidades foram vendidas no meio tempo', async () => {
    await expect(conferirEstoqueAoReativar(tx(9), ['p1'])).rejects.toThrow(
      'Camisa (P): restam só 1 unidade',
    );
    await expect(conferirEstoqueAoReativar(tx(10), ['p1'])).rejects.toThrow(
      'Camisa (P) esgotou',
    );
  });

  it('libera quando ainda cabe, ou sem limite de estoque', async () => {
    await expect(conferirEstoqueAoReativar(tx(8), ['p1'])).resolves.toBe(
      undefined,
    );
    await expect(
      conferirEstoqueAoReativar(tx(500, null), ['p1']),
    ).resolves.toBe(undefined);
  });
});
