# PayPal

Como a integração PayPal foi montada e por que — em particular o que a separa
dos outros gateways. Para o desenho geral (contrato dos adapters, cofre de
credenciais, recorte por igreja), ver [`pagamentos.md`](./pagamentos.md).

- adapter: `src/gateways/paypal/paypal.gateway.ts`
- HTTP: `src/gateways/paypal/paypal.client.ts`
- testes: `paypal.gateway.spec.ts` e o bloco PayPal de
  `src/gateways/webhook-verification.spec.ts`

## Visão geral

**Orders v2 com redirecionamento.** O backend cria um pedido
(`POST /v2/checkout/orders`, `intent: CAPTURE`), recebe o link `payer-action` e
devolve ao front. O inscrito paga no site do PayPal, com saldo da conta ou
cartão; nada de cartão passa por nós.

## Aprovar não é pagar

Esta é a diferença que molda o adapter inteiro. Nos outros gateways, o inscrito
paga e o dinheiro entra. No PayPal o inscrito **aprova** o pedido, e o dinheiro
só se move quando **o servidor chama a captura**
(`POST /v2/checkout/orders/{id}/capture`).

Pela especificação do Orders v2, o pedido tem **6 horas** depois do
redirecionamento para ser aprovado e capturado. Pedido aprovado e não capturado
expira e o inscrito fica sem pagar, achando que pagou.

Por isso a captura não mora num lugar só. `pedidoAtual` lê o pedido e, se
estiver `APPROVED`, captura e relê. Os três caminhos que olham um pedido passam
por ela:

| Caminho | Quando |
|---|---|
| webhook `CHECKOUT.ORDER.APPROVED` | segundos depois da aprovação |
| reconciliação (cron de 3 em 3 h) | se o webhook não chegou — cabe na janela de 6 h |
| conferência antes de um checkout novo | o inscrito clicou em pagar de novo |

Captura repetida (webhook e cron ao mesmo tempo) é inofensiva: o PayPal
responde **422**, o cliente registra um aviso e o pedido é relido. O mesmo 422
cobre o cartão recusado na hora da captura — aí o pedido continua `APPROVED`
sem captura, vira `WAITING`, e o inscrito pode gerar um link novo.

## Sem busca por referência

O Orders v2 só consulta pedido pelo **id do pedido**, nunca pela nossa
referência. Por isso `listCharges` ganhou um terceiro parâmetro, `checkoutId`
(o id que `createCheckout` devolveu e que fica em `PaymentCheckout.checkoutId`).
Os outros adapters ignoram. O adapter ainda confere que o `reference_id` do
pedido é a referência pedida antes de devolver qualquer coisa.

## Credenciais

| Campo | O que é | Segredo |
|---|---|---|
| `clientId` | Client ID da aplicação REST | não — é público em qualquer integração com o SDK do PayPal |
| `clientSecret` | Secret da mesma aplicação | sim |

Saem de **developer.paypal.com › Apps & Credentials**. **Sandbox e Live são
abas diferentes, com credenciais diferentes e endereços diferentes**
(`api-m.sandbox.paypal.com` e `api-m.paypal.com`). O `mode` da configuração
escolhe o endereço. Credencial de um ambiente no outro dá 401, e o teste de
conexão diz isso com essas palavras.

O token OAuth é pedido a cada operação. Custa uma chamada a mais e evita um
cache de token por igreja. Se o `/v1/oauth2/token` começar a responder 429,
é hora de cachear (o comentário `ponytail:` no cliente marca o lugar).

## Moeda: só conta brasileira

O pedido sai em **BRL**. Pela documentação do PayPal, o real é aceito como moeda
de pagamento **apenas em contas brasileiras**. Uma igreja que cadastrar uma conta
PayPal de outro país vai passar no teste de conexão e falhar na primeira
cobrança.

## Desconto

O PayPal tem `breakdown.discount`, mas o adapter usa `aplicarDesconto`, como
Mercado Pago, InfinitePay e Ton. O total enviado tem que ser o mesmo
`chargedAmountCents` que a conferência de valor usa, e os dois saem da mesma
função. O PayPal também recusa o pedido inteiro quando `item_total` não é
**exatamente** a soma dos itens, então tudo é calculado a partir dos mesmos
centavos e só convertido para texto (`"150.00"`) no fim. Há teste para isso.

## Webhook

**O cadastro é no painel**: webhook no PayPal pertence à aplicação, não ao
pedido. Em **Apps & Credentials › sua aplicação › Webhooks**, cadastre a URL que
a tela de configurações mostra (`/webhooks/paypal/<segredo>/payments`) e assine
pelo menos estes eventos:

- `CHECKOUT.ORDER.APPROVED` — é o que dispara a captura;
- `PAYMENT.CAPTURE.COMPLETED`;
- `PAYMENT.CAPTURE.PENDING`;
- `PAYMENT.CAPTURE.DECLINED`.

Sem o cadastro a integração **funciona, só mais devagar**: a captura fica para
a reconciliação (até 3 h) ou para o próximo clique em pagar.

### Por que a assinatura não é conferida

O PayPal assina com certificado. Conferir exige o `webhook_id` da aplicação e
uma chamada assíncrona (baixar o certificado ou chamar
`/v1/notifications/verify-webhook-signature`), e `verifyWebhook` é síncrono no
contrato.

A garantia é a mesma do PagBank: **o corpo só aponta o pedido**. O estado vem de
um `GET` autenticado com a credencial da igreja. Um POST forjado com a URL certa
consegue, no máximo, fazer o sistema conferir um pedido real daquela conta, e a
captura só acontece se o próprio PayPal disser que o comprador aprovou. Por isso
o descriptor declara `signsWebhook: true` (a tela não mostra o alerta de "o
segredo é a única tranca", porque não é).

## Status

| PayPal | Sistema |
|---|---|
| captura `COMPLETED` | `PAID` |
| captura `PARTIALLY_REFUNDED` | `PAID` (devolução parcial é acerto feito pela organização) |
| captura `PENDING` | `IN_ANALYSIS` |
| captura `DECLINED` / `FAILED` | `DECLINED` |
| captura `REFUNDED` | `REFUNDED` |
| pedido `VOIDED` | `CANCELED` |
| qualquer outro pedido sem captura | `WAITING` |

O método vira `CREDIT_CARD` quando o pedido traz `payment_source.card`, e
`OTHER` quando o inscrito pagou pela carteira PayPal. O código da transação no
painel é o id da **captura**, que é o que aparece no extrato do PayPal.

## Testando no sandbox

1. Em developer.paypal.com, pegue Client ID e Secret da aba **Sandbox** e
   cadastre na tela de pagamentos com o ambiente **Sandbox**.
2. Em **Testing Tools › Sandbox Accounts**, use a conta *Personal* que o PayPal
   cria (ou crie uma do Brasil) para pagar.
3. Gere um link numa inscrição, pague com a conta de teste e confira que a
   inscrição vira paga. Sem o webhook cadastrado, o botão **Conferir no
   gateway** da Tesouraria (perfil dev) força a captura.

## Em aberto

- **Link antigo não é cancelado.** O Orders v2 não cancela pedido não aprovado:
  ele expira sozinho em 6 h. Quando um link novo substitui o antigo (depois de
  1 h), o antigo ainda pode ser aprovado nesse intervalo, e o webhook dele seria
  capturado. É o mesmo risco da InfinitePay. A diferença é que aqui a captura é
  nossa, então dá para fechar: bastaria não capturar pedido cujo
  `PaymentCheckout` está `INACTIVE`. Isso exige o adapter consultar o banco,
  que hoje ele não conhece. Fica para quando acontecer.
- **Taxas não aparecem na tela.** O PayPal não publica a tabela brasileira numa
  página legível (a oficial bloqueia leitura e as fontes de terceiros divergem),
  então `PROVIDER_PRICING` no front não tem o PayPal. O cartão mostra só os
  métodos aceitos.
- **Nenhuma igreja fechou um ciclo em produção** — selo "Em teste" no front.
