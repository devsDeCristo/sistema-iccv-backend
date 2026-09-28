# Loja e produtos

Cada evento pode vender produtos (camisa, caneca, livro) junto ou à parte do
ingresso. Este documento cobre produto, variante, estoque, compra e entrega.
O checkout e o gateway ficam em [`pagamentos.md`](./pagamentos.md).

## Modelo (`EventProduct` / `EventProductVariant`)

| Campo | Onde | Significado |
| --- | --- | --- |
| `name`, `description`, `price` | `EventProduct` | o preço é do produto, não da variante — camisa P e GG custam o mesmo; preços diferentes exigem produtos diferentes |
| `images` | `EventProduct` | até 5 fotos (`MAXIMO_DE_FOTOS`), a primeira é a capa; cada uma é uma data URL gravada no banco |
| `name`, `stock` | `EventProductVariant` | a escolha dentro do produto (tamanho, cor); `stock` nulo é sem limite |

- **Vendido não é contador próprio:** sai da soma dos itens (`PaymentProductItem`) em pagamentos que ainda valem. Cancelar, estornar ou remover a inscrição devolve a unidade sem que nenhum caminho precise lembrar de devolver.
- **Foto:** data URL PNG/JPEG/WebP, até 700 KB (`TAMANHO_MAXIMO_DA_FOTO`); o front já reduz antes de enviar, o teto trava quem chamar a API por fora.

Arquivo: `prisma/schema.prisma` (models `EventProduct`, `EventProductVariant`, `PaymentProductItem`).

## Cadastro de produtos (`validarProdutos`, `validarFotos`)

- **Nome obrigatório** em produto e variante.
- **Preço:** número finito e não negativo.
- **Ao menos uma variante:** a compra sempre aponta para uma variante; produto sem escolha (uma caneca) usa uma variante única.
- **Variantes não repetem nome** (comparação sem diferenciar maiúscula/minúscula).
- **Estoque de variante:** se informado, inteiro não negativo.
- **Fotos:** lista com no máximo 5 itens; cada uma passa por `validarFoto` (formato e tamanho); campo ausente no corpo não mexe nas fotos atuais, `null` ou lista vazia remove todas.

Arquivo: `src/event/event-products.ts` (`validarProdutos`, `validarFotos`, `validarFoto`).

## Edição do evento: `operacoesDeProdutos`

Faz o diff dos produtos recebidos contra os atuais do evento — remove o que
sumiu, atualiza o que veio com id, cria o que veio sem id.

- **Produto ou variante já comprada não pode ser removida**, mesmo com a compra cancelada: a linha do item (`PaymentProductItem`) aponta para a variante, e o banco trava com `onDelete: Restrict`. A tentativa de remoção recebe `400` ("já foi comprado e não pode ser removido").
- **Id que não pertence ao evento** é recusado com `400` — sem essa conferência, um id emprestado editaria produto de outra igreja.

Arquivo: `src/event/event.service.ts` (`operacoesDeProdutos`).

## Quem compra na loja (`podeComprarNaLoja`)

| Situação | `publicStore: false` (padrão) | `publicStore: true` |
| --- | --- | --- |
| Inscrição confirmada | compra | compra |
| Só na lista de espera | não compra | não compra |
| Sem inscrição, comprando para si | não compra | compra |
| Compra em nome de terceiro (`porOutraPessoa`) | não compra | **não compra** (só vale para quem tem inscrição confirmada) |

- **`publicStore`** é um campo livre em `event.data`, decisão do evento.
- **Terceiro nunca herda a loja pública:** ela é aberta a quem compra para si; em nome de outra pessoa a regra volta a exigir inscrição confirmada, senão um admin criaria cobrança na conta de qualquer usuário do sistema.
- **Evento inativo (`EventStatus.INACTIVE`)** bloqueia a compra antes de checar loja pública: "A loja deste evento está fechada" (`400`).

Arquivo: `src/event/event-products.ts` (`podeComprarNaLoja`), `src/event/event.service.ts` (`_comprarProdutosTx`).

## Comprar em nome de terceiro

- **`porOutraPessoa`** é verdadeiro quando quem chama (`requesterId`) é diferente de quem recebe o produto (`userId`).
- Antes de comprar, passa por `assertEventIsVisible` (evento em teste só é visível para quem enxerga) e `assertPodeInscrever` (mesma trava de permissão da inscrição em nome de outro).

## Comprar produtos (`comprarProdutos` / `_comprarProdutosTx`)

Duas formas, conforme `attachToRegistration` no corpo:

- **Junto do ingresso** (oferta logo após a inscrição): os itens entram no `Payment` do ingresso, se ele ainda aceitar produtos (`ingressoQueAceitaProdutos` — em aberto, sem checkout ativo, sem produto ainda dentro). Somam no `amount` do mesmo pagamento e vão no mesmo checkout: pagar o ingresso é pagar os produtos.
- **Compra avulsa** (pela página do evento, ou quando o ingresso já não aceita itens): cria um `Payment` próprio, sem `roleRegistrationId`. Precisa ser separado porque o ingresso pode já estar pago — somar produto num pagamento quitado esconderia valor devido atrás de um "pago".

Nos dois casos, baixa manual, estorno, dashboard e reconciliação continuam valendo — para eles é só mais um pagamento do evento.

- **Trava de concorrência:** a compra roda em transação `Serializable` (`emTransacaoSerializavel`/`$transaction` com esse isolamento) — duas pessoas levando a última unidade ao mesmo tempo leriam as duas "resta 1" em `READ COMMITTED`; em `Serializable` uma das duas recebe conflito e refaz. Conflito de serialização (`40001`/`P2034`) tem retry automático, até 5 tentativas, sem repetir as checagens de permissão (que já passaram na primeira).
- **Conferência de estoque (`conferirEstoque`):** compara o pedido contra o estoque menos o vendido (pagamentos que não liberam estoque). Mensagem de erro diz quanto sobrou ("restam só N unidades") ou "esgotou", nunca um genérico.
- **Produto gratuito (`totalEmCentavos === 0`):** só é liberado para quem já tem inscrição confirmada. Na loja pública, sem essa regra, qualquer conta nova levaria o brinde inteiro, sem estoque definido e sem fim.

Arquivos: `src/event/event.service.ts` (`comprarProdutos`, `_comprarProdutosTx`, `ingressoQueAceitaProdutos`, `vendidosPorVariante`), `src/event/event-products.ts` (`conferirEstoque`, `disponivel`, `montarPedido`).

## Rota

| Método | Caminho | Quem pode |
| --- | --- | --- |
| `POST` | `/event/:idEvent/users/:idUser/products` | usuário autenticado (`JwtAuthGuard`); compra para si ou, com permissão de inscrever outra pessoa, para terceiro |

Corpo (`ProductPurchaseDto`): `attachToRegistration` (opcional, padrão `false`) e
`items` (lista de `{ variantId, quantity }`, quantidade entre 1 e 20 por item
— `QUANTIDADE_MAXIMA_POR_ITEM`). Item repetido no mesmo pedido é recusado
(`400`) em vez de somado — duas linhas iguais indicam front com defeito.

Arquivos: `src/event/event.controller.ts` (`buyProducts`), `src/event/dto/event.dto.ts` (`ProductPurchaseDto`).

## Reativação de compra cancelada (`reativarCompras`)

Encontrada em `src/event/event-products.ts`, usada por `src/payment/payment.service.ts`
(reprocessar pagamento e atualização manual de status).

Uma compra `CANCELED` ou `REFUNDED` devolveu as unidades ao estoque. Voltar a
valer — pagar de novo, ou o admin trocar o status manualmente — significa
pegar essas unidades de volta, e elas podem ter sido vendidas nesse meio
tempo. `reativarCompras`:

- **Ingresso nunca fica preso por causa de produto:** pagamento com ingresso (`roleRegistrationId` preenchido) sempre reativa, com os itens que ainda couberem; o que não cabe mais sai do pagamento (e o valor sai junto).
- **Compra só de produto** só reativa se sobrar ao menos um item; sem nenhum, continua cancelada, com os itens como estavam, e a função devolve uma mensagem de recusa (mesmo texto de falta de estoque).
- **Não muda o status sozinha:** quem chama grava o novo status na mesma transação, que precisa ser `Serializable` (`emTransacaoSerializavel`, mesma trava e retry da compra nova).

Usos confirmados em `payment.service.ts`: reprocessar pagamento (cobrar de
novo o que ficou cancelado) e atualização manual de status pelo admin (tirar
de cancelado/estornado reativa os produtos).

## Entrega de produtos

`Payment` tem `productsDeliveredAt` e `productsDeliveredById`. A entrega é da
compra inteira, não de cada item — quem leva duas camisas paga uma vez e
recebe as duas de uma vez. `productsDeliveredAt` nulo é o normal (ainda não
entregue, ou a compra nem tem produto).

Regras (`updateProductsDelivery`):

- Compra sem nenhum `PaymentProductItem` não pode ser marcada como entregue (`400`).
- Marcar como entregue só vale com pagamento `PAID` (`400` fora disso).
- Desfazer a entrega vale em qualquer status.

| Método | Caminho | Quem pode |
| --- | --- | --- |
| `PATCH` | `/payment/payments/:paymentId/products-delivery` | papéis de área administrativa (`ADMIN_AREA_ROLES`) |

Arquivos: `src/payment/payment.service.ts` (`updateProductsDelivery`),
`src/payment/payment.controller.ts`.

## Remoção do evento

No schema, `EventProduct.event` e `EventProductVariant.product` têm
`onDelete: Cascade`: apagar o evento apaga seus produtos e variantes.
`PaymentProductItem.variant` tem `onDelete: Restrict` — trava de banco que
impede apagar uma variante com item comprado por fora da API, reforçando a
regra já aplicada em `operacoesDeProdutos`. `PaymentProductItem.payment` tem
`onDelete: Cascade`: remover a inscrição apaga a cobrança e, com ela, a
reserva de estoque dos produtos daquele pagamento.

Arquivo: `prisma/schema.prisma`.

## Tela correspondente

`ic-front`, `docs/loja-do-evento.md`.
