import { BadRequestException } from '@nestjs/common';
import { PaymentStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * Pagamentos que devolvem a unidade ao estoque. Recusado (`DECLINED`) não
 * entra: a pessoa tenta pagar de novo pelo mesmo checkout, e a camisa dela não
 * pode ser vendida para outro no meio da segunda tentativa.
 */
export const STATUS_QUE_LIBERAM_ESTOQUE: PaymentStatus[] = [
  PaymentStatus.CANCELED,
  PaymentStatus.REFUNDED,
];

/**
 * Teto da foto, em caracteres da data URL (~520 KB de imagem). A foto vai
 * inteira em toda abertura do evento, e o front já a reduz antes de enviar —
 * isto é a trava para quem chamar a API por fora.
 */
export const TAMANHO_MAXIMO_DA_FOTO = 700_000;

/** Fotos por produto; a primeira é a capa */
export const MAXIMO_DE_FOTOS = 5;

const FORMATO_DA_FOTO =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Unidades de uma variante num pedido: acima disso é engano de digitação. */
export const QUANTIDADE_MAXIMA_POR_ITEM = 20;

export type VarianteRecebida = {
  id?: string;
  name: string;
  stock?: number | null;
};

export type ProdutoRecebido = {
  id?: string;
  name: string;
  description?: string | null;
  price: number;
  images?: string[] | null;
  variants: VarianteRecebida[];
};

/**
 * Normaliza a foto: vazio vira `null` (sem foto) e `undefined` segue
 * `undefined` (não mexer). Recusa o que não é imagem em base64 ou passa do teto
 * — texto qualquer gravado ali iria direto para um `<img src>` na tela.
 */
export function validarFoto(image?: string | null): string | null | undefined {
  if (image === undefined) return undefined;
  if (image === null || image === '') return null;

  if (image.length > TAMANHO_MAXIMO_DA_FOTO) {
    throw new BadRequestException(
      'A foto do produto é grande demais. Envie uma imagem menor.',
    );
  }

  if (!FORMATO_DA_FOTO.test(image)) {
    throw new BadRequestException(
      'A foto do produto precisa ser PNG, JPG ou WebP',
    );
  }

  return image;
}

/**
 * As fotos de um produto: `undefined` não mexe, `null` ou lista vazia remove
 * todas. Cada uma passa por `validarFoto`, e as vazias caem fora — a ordem é a
 * de quem cadastrou, e a primeira vira a capa.
 */
export function validarFotos(images?: string[] | null): string[] | undefined {
  if (images === undefined) return undefined;
  if (images === null) return [];

  if (!Array.isArray(images)) {
    throw new BadRequestException('As fotos do produto precisam vir em lista');
  }
  if (images.length > MAXIMO_DE_FOTOS) {
    throw new BadRequestException(
      `Um produto pode ter até ${MAXIMO_DE_FOTOS} fotos`,
    );
  }

  return images
    .map((foto) => validarFoto(foto))
    .filter((foto): foto is string => !!foto);
}

/** Regras de cadastro que o class-validator não expressa sozinho. */
export function validarProdutos(produtos: ProdutoRecebido[]) {
  for (const produto of produtos) {
    const nome = produto.name?.trim();

    if (!nome) {
      throw new BadRequestException('Todo produto precisa de um nome');
    }

    if (!Number.isFinite(produto.price) || produto.price < 0) {
      throw new BadRequestException(`Preço inválido no produto "${nome}"`);
    }

    // a compra aponta para uma variante: produto sem nenhuma não é vendável.
    // Quem não tem escolha a fazer (uma caneca) usa uma variante única.
    if (!produto.variants?.length) {
      throw new BadRequestException(
        `O produto "${nome}" precisa de pelo menos uma variante`,
      );
    }

    const nomesDasVariantes = new Set<string>();

    for (const variante of produto.variants) {
      const nomeDaVariante = variante.name?.trim();

      if (!nomeDaVariante) {
        throw new BadRequestException(
          `Toda variante do produto "${nome}" precisa de um nome`,
        );
      }

      // "P" e "p" na mesma lista são a mesma escolha para quem compra
      const chave = nomeDaVariante.toLocaleLowerCase('pt-BR');
      if (nomesDasVariantes.has(chave)) {
        throw new BadRequestException(
          `A variante "${nomeDaVariante}" aparece duas vezes no produto "${nome}"`,
        );
      }
      nomesDasVariantes.add(chave);

      if (
        variante.stock !== null &&
        variante.stock !== undefined &&
        (!Number.isInteger(variante.stock) || variante.stock < 0)
      ) {
        throw new BadRequestException(
          `Estoque inválido na variante "${nomeDaVariante}" do produto "${nome}"`,
        );
      }
    }
  }
}

/**
 * Pedido de compra → quantidade por variante. Recusa variante repetida em vez
 * de somar: duas linhas iguais são um front com defeito, e somar esconderia o
 * defeito cobrando o dobro.
 */
export function montarPedido(
  itens: { variantId: string; quantity: number }[],
): Map<string, number> {
  if (!itens?.length) {
    throw new BadRequestException('Escolha pelo menos um produto');
  }

  const pedido = new Map<string, number>();

  for (const item of itens) {
    if (
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > QUANTIDADE_MAXIMA_POR_ITEM
    ) {
      throw new BadRequestException(
        `A quantidade de cada item deve ficar entre 1 e ${QUANTIDADE_MAXIMA_POR_ITEM}`,
      );
    }

    if (pedido.has(item.variantId)) {
      throw new BadRequestException('O mesmo item foi enviado duas vezes');
    }

    pedido.set(item.variantId, item.quantity);
  }

  return pedido;
}

export type VarianteComEstoque = {
  id: string;
  name: string;
  stock: number | null;
  productName: string;
};

/** Quanto ainda dá para vender; `null` é sem limite. */
export function disponivel(
  stock: number | null,
  vendidos: number,
): number | null {
  return stock === null ? null : Math.max(0, stock - vendidos);
}

/**
 * Confere o pedido contra o estoque. A mensagem diz quanto sobrou: "esgotou"
 * para quem pediu 3 quando restavam 2 faria a pessoa desistir de uma compra
 * que ainda cabe.
 */
export function conferirEstoque(
  variantes: VarianteComEstoque[],
  vendidos: Map<string, number>,
  pedido: Map<string, number>,
) {
  for (const variante of variantes) {
    const restante = disponivel(variante.stock, vendidos.get(variante.id) ?? 0);
    const quero = pedido.get(variante.id) ?? 0;

    if (restante === null || quero <= restante) continue;

    throw new BadRequestException(faltaDeEstoque(variante, restante));
  }
}

function faltaDeEstoque(variante: VarianteComEstoque, restante: number) {
  const item = `${variante.productName} (${variante.name})`;

  return restante === 0
    ? `${item} esgotou`
    : `${item}: restam só ${restante} unidade${restante === 1 ? '' : 's'}`;
}

/**
 * Quem compra na loja é decisão do evento (`data.publicStore`): restrita, só
 * quem tem inscrição confirmada; pública, qualquer pessoa com cadastro.
 * Restrita é o padrão — era a única regra antes de a opção existir.
 */
export function podeComprarNaLoja(
  inscrito: boolean,
  dadosDoEvento: unknown,
  /**
   * Compra feita pelo painel em nome de outra pessoa. A loja pública é aberta
   * a quem compra para si; em nome de terceiro vale só para inscrito, senão
   * o admin criaria cobrança na conta de qualquer usuário do sistema.
   */
  porOutraPessoa = false,
) {
  return (
    inscrito ||
    (!porOutraPessoa &&
      (dadosDoEvento as { publicStore?: unknown } | null)?.publicStore === true)
  );
}

/**
 * Transação serializável com nova tentativa no conflito — a mesma trava da
 * compra nova. Quem lê "resta 1" e grava em cima disso precisa dela: em
 * READ COMMITTED, duas transações no mesmo segundo leem o mesmo 1.
 */
export async function emTransacaoSerializavel<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  tentativas = 5,
): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 30000,
      });
    } catch (error: any) {
      const conflito = error?.code === '40001' || error?.code === 'P2034';
      if (!conflito || tentativa >= tentativas) throw error;
    }
  }
}

export type Reativacao = {
  /** voltam a valer: os com ingresso, e as compras em que algo ainda coube */
  reativados: string[];
  /** itens tirados do pagamento por falta de estoque */
  itensRemovidos: string[];
  /** por que uma compra só de produto continuou cancelada */
  recusa?: string;
};

/**
 * Compra cancelada ou estornada devolveu as unidades ao estoque. Voltar a
 * valer — pagar de novo, ou o admin mudar o status — é pegar as unidades outra
 * vez, e elas podem ter sido vendidas nesse meio tempo.
 *
 * O que não cabe mais sai do pagamento, e o valor sai junto. O ingresso nunca
 * fica preso por causa de uma camisa: o pagamento com ingresso volta sempre,
 * com os produtos que ainda couberem. A compra só de produto volta se sobrar
 * algum item; sem nenhum, continua cancelada, com os itens como estavam.
 *
 * Não muda o status — quem chama grava o novo, na mesma transação, que tem
 * de ser serializável (`emTransacaoSerializavel`).
 */
export async function reativarCompras(
  tx: Prisma.TransactionClient,
  paymentIds: string[],
): Promise<Reativacao> {
  const pagamentos = await tx.payment.findMany({
    where: {
      id: { in: paymentIds },
      status: { in: STATUS_QUE_LIBERAM_ESTOQUE },
    },
    select: {
      id: true,
      amount: true,
      roleRegistrationId: true,
      productItems: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          variantId: true,
          quantity: true,
          unitPrice: true,
          variant: {
            select: {
              name: true,
              stock: true,
              product: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const itens = pagamentos.flatMap((pagamento) => pagamento.productItems);

  // os próprios itens não entram: estão em pagamento cancelado ou estornado
  const vendidos = itens.length
    ? await tx.paymentProductItem.groupBy({
        by: ['variantId'],
        where: {
          variantId: { in: [...new Set(itens.map((item) => item.variantId))] },
          payment: { status: { notIn: STATUS_QUE_LIBERAM_ESTOQUE } },
        },
        _sum: { quantity: true },
      })
    : [];

  const restantes = new Map<string, number | null>();
  for (const item of itens) {
    const vendido =
      vendidos.find((linha) => linha.variantId === item.variantId)?._sum
        .quantity ?? 0;
    restantes.set(item.variantId, disponivel(item.variant.stock, vendido));
  }

  const reativacao: Reativacao = { reativados: [], itensRemovidos: [] };

  for (const pagamento of pagamentos) {
    const fora: typeof pagamento.productItems = [];
    // o que este pagamento pega, para devolver se ele não voltar
    const pegos = new Map<string, number>();

    for (const item of pagamento.productItems) {
      const resta = restantes.get(item.variantId) ?? null;

      if (resta === null) continue;
      if (item.quantity > resta) {
        fora.push(item);
        continue;
      }

      restantes.set(item.variantId, resta - item.quantity);
      pegos.set(
        item.variantId,
        (pegos.get(item.variantId) ?? 0) + item.quantity,
      );
    }

    const sobrou = pagamento.productItems.length > fora.length;

    if (!pagamento.roleRegistrationId && !sobrou) {
      const item = fora[0];
      reativacao.recusa ??= faltaDeEstoque(
        {
          id: item.variantId,
          name: item.variant.name,
          stock: item.variant.stock,
          productName: item.variant.product.name,
        },
        restantes.get(item.variantId) ?? 0,
      );
      for (const [variantId, quantidade] of pegos) {
        restantes.set(variantId, (restantes.get(variantId) ?? 0) + quantidade);
      }
      continue;
    }

    if (fora.length) {
      const semEmCentavos = fora.reduce(
        (soma, item) => soma + Math.round(item.unitPrice * 100) * item.quantity,
        0,
      );

      await tx.paymentProductItem.deleteMany({
        where: { id: { in: fora.map((item) => item.id) } },
      });
      await tx.payment.update({
        where: { id: pagamento.id },
        data: {
          amount: (Math.round(pagamento.amount * 100) - semEmCentavos) / 100,
        },
      });
      reativacao.itensRemovidos.push(...fora.map((item) => item.id));
    }

    reativacao.reativados.push(pagamento.id);
  }

  return reativacao;
}
