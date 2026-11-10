# PayPal

Como a integração PayPal foi montada e por que — em particular o que a separa
dos outros gateways. Para o desenho geral (contrato dos adapters, cofre de
credenciais, recorte por igreja), ver [`pagamentos.md`](./pagamentos.md).

- adapter: `src/gateways/paypal/paypal.gateway.ts`
- HTTP: `src/gateways/paypal/paypal.client.ts`
- testes: `paypal.gateway.spec.ts`, o bloco PayPal de
  `src/gateways/webhook-verification.spec.ts` e
  `src/payment/pix-na-tela.spec.ts`

## Visão geral

Duas formas de pagar, e é o único gateway em que elas são **pedidos
diferentes**:

- **Cartão ou saldo PayPal — Orders v2 com redirecionamento.** O backend cria um
  pedido (`POST /v2/checkout/orders`, `intent: CAPTURE`), recebe o link
  `payer-action` e devolve ao front. O inscrito paga no site do PayPal; nada de
  cartão passa por nós.
- **Pix — na tela do sistema.** O PayPal não mostra Pix na página dele. O pedido
  nasce com `payment_source.pix` e devolve o copia e cola; quem mostra o QR é o
  front. Ver [Pix na tela do sistema](#pix-na-tela-do-sistema).

Como o tipo do pedido é decidido na criação, **o inscrito escolhe antes**. Isso
só existe aqui: nos outros gateways a página deles oferece as formas lado a
lado, e nada desta escolha os alcança.

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
| `pix` | chave "Aceitar Pix" (`'true'` ou ausente) | não |

`pix` é o primeiro campo `toggle` do sistema: a tela desenha uma chave em vez de
uma caixa de texto, e desligado é o campo ausente. Nasce desligado porque a
conta PayPal precisa ter o Pix habilitado — ligar sem isso é oferecer ao
inscrito uma opção que dá erro.

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

- `CHECKOUT.ORDER.APPROVED` — é o que dispara a captura do cartão;
- `CHECKOUT.ORDER.COMPLETED` — Pix pago;
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED` — Pix expirado ou cancelado;
- `PAYMENT.CAPTURE.COMPLETED`;
- `PAYMENT.CAPTURE.PENDING`;
- `PAYMENT.CAPTURE.DECLINED`.

Cada família guarda o pedido num lugar, e `pedidoCitado` conhece os três: os
avisos `CHECKOUT.*` trazem o próprio pedido (`id`, ou `order_id` no
`REVERSED`); os `PAYMENT.CAPTURE.*` trazem a captura, com o pedido em
`supplementary_data.related_ids.order_id` no cartão e **só no link `up`** no
Pix. O corpo nunca passa disso: aponta o pedido, e o estado vem da API.

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

O método sai de `payment_source`: `pix` vira `PIX`, `card` vira `CREDIT_CARD`
e a carteira PayPal vira `OTHER`. **Sem captura o método fica `OTHER`**, de
propósito: a tela trata "aguardando com forma definida" como cobrança em
andamento e trava o botão de pagar — e é por esse botão que o inscrito volta ao
QR que fechou, ou tenta de novo depois de um cartão recusado. O código da
transação no painel é o id da **captura**, que é o que aparece no extrato do
PayPal.

## Testando no sandbox

1. Em developer.paypal.com, pegue Client ID e Secret da aba **Sandbox** e
   cadastre na tela de pagamentos com o ambiente **Sandbox**.
2. Em **Testing Tools › Sandbox Accounts**, use a conta *Personal* que o PayPal
   cria (ou crie uma do Brasil) para pagar.
3. Gere um link numa inscrição, pague com a conta de teste e confira que a
   inscrição vira paga. Sem o webhook cadastrado, o botão **Conferir no
   gateway** da Tesouraria (perfil dev) força a captura.
4. Para o Pix: habilite o Pix na conta sandbox (ver
   [Habilitar na conta](#habilitar-na-conta)), ligue **Aceitar Pix** na
   configuração e pague de novo. A pergunta da forma de pagamento aparece, e
   escolhendo Pix abre a tela do QR. Sem webhook, o botão **Já paguei** da
   própria tela confere no PayPal.

## Pix na tela do sistema

Decisão de 10/11/2026: Pix aqui, cartão no checkout do PayPal. É a única
exceção à regra de "sempre checkout hospedado", e existe porque o PayPal não
hospeda o Pix (a documentação dele diz "QR code (merchant hosted)"). Não há
dado de cartão envolvido.

### A escolha

`PaymentGateway.paymentMethodChoices(ctx)` é opcional, e só este adapter o
implementa: devolve `[PIX, CREDIT_CARD]` quando a igreja ligou a chave "Aceitar
Pix", e lista vazia quando não. Em `createCheckout` (serviço de pagamento):

- lista com duas formas e nenhuma escolha válida no corpo (`method`) → a
  resposta é `{ choice: { provider, label, methods } }`, **sem link e sem
  nenhuma escrita**. O front pergunta e repete a chamada com `method`;
- gateway sem o método, ou com a chave desligada → nada muda: link direto.

A pergunta é do front, mas a regra é do servidor: uma forma que o gateway não
ofereceu é tratada como ausente, e a pergunta volta.

### O pedido

`payment_source.pix` com nome, CPF (só dígitos), e-mail e telefone do inscrito,
`qr_expiry` em segundos (a validade do checkout, dentro dos limites do PayPal:
10 minutos a 72 horas) e `processing_instruction:
ORDER_COMPLETE_ON_PAYMENT_APPROVAL` — **captura automática**. No Pix o dinheiro
já saiu da conta de quem pagou; não há o que revisar, e a regra de "aprovar não
é pagar" lá de cima não se aplica. Se por algum motivo o pedido aparecer
`APPROVED`, `pedidoAtual` captura do mesmo jeito.

A resposta traz `qr_payload` (o copia e cola no padrão do Banco Central, de
onde o QR é desenhado) e não traz link. O adapter devolve
`HostedCheckoutResult.pix = { code, expiresAt }`, e o serviço:

- grava em `PaymentCheckout.pixCode` e `pixExpiresAt`;
- põe em `link` o endereço da **nossa** tela:
  `<front>/eventos/<evento>/pagamento/pix/<referência>`.

Para o resto do sistema continua sendo "o checkout tem um link": a
reutilização, o extrato e a reconciliação não sabem que este é diferente.

### A tela e as duas rotas

| Rota | O que faz |
|---|---|
| `GET events/:idEvent/users/:idUser/payments/pix/:referenceId` | código, validade, valor e estado — **só leitura do banco** |
| `POST …/pix/:referenceId/check` | "Já paguei": pergunta ao gateway agora e aplica o resultado |

Três regras que não podem se perder:

1. **O código só sai do servidor.** A tela recebe a referência pela URL e busca
   o código aqui. Nada do que é pago vem da URL nem é montado no navegador: um
   QR trocado na tela é dinheiro na conta de outra pessoa, e Pix não volta.
2. **O recorte é o inscrito e o evento da rota.** A consulta filtra por
   `payment: { userId, eventId }`; referência de outra pessoa responde 404,
   igual a uma que não existe. As rotas ficam sob os mesmos guards da criação
   do checkout.
3. **A tela não dá baixa.** O `GET` é consultado a cada 5 s e não fala com o
   gateway — falar estouraria o limite de chamadas da conta da igreja (o PayPal
   pede no máximo uma consulta a cada 3–5 s por pedido). Quem muda o estado é o
   webhook, a reconciliação ou o `check`, e o `check` passa por
   `updatePaymentWebhook`: a conferência de valor vale igual.

`active: false` na resposta quer dizer que um checkout novo tomou o lugar
deste. O QR antigo ainda seria aceito pelo banco, então a tela para de
mostrá-lo.

### Reutilização

O checkout ativo só é reaproveitado se for **da forma pedida agora** (quem
gerou um Pix e voltou escolhendo cartão precisa de outro pedido) e, sendo Pix,
se ainda sobrarem 5 minutos de validade — devolver um QR prestes a expirar é
pior que gerar outro.

### Habilitar na conta

Conta empresarial brasileira, em **Account Settings › Products & Services ›
Payment Methods › Setup Pix**; se a opção não aparecer, o PayPal tem um
formulário de solicitação (links em
`developer.paypal.com/limited-release/alternative-payment-methods/pix/set-up`).
A ativação passa por análise de elegibilidade do PayPal. Há sandbox. O saque do
Pix é para a chave Pix cadastrada, em D+1.

### A confirmar no sandbox

A documentação do Pix é marcada LIMITED (set/2026) e o adapter foi escrito por
ela, sem conta habilitada para testar. O que precisa ser visto com uma:

- `shipping_preference: NO_SHIPPING` é aceito no Pix (o exemplo deles usa
  `GET_FROM_FILE`);
- o formato do telefone (enviamos DDD + número, sem o 55);
- `qr_payload` é lido pelos apps de banco (o outro campo, `qr_image`, vem num
  formato `pix://pay?…` que não parece ser);
- o `GET` do pedido pago devolve `payment_source.pix` — é de onde sai o método
  `PIX`; se não devolver, a baixa acontece igual e o método fica `OTHER`;
- o formato do `CHECKOUT.PAYMENT-APPROVAL.REVERSED` e o estado do pedido depois
  de o QR expirar;
- que nome aparece como recebedor no app do banco (a tela avisa que pode ser o
  do PayPal).

## Boleto

Não está na integração: é beta no PayPal, a única integração documentada é pelo
SDK JavaScript com campos montados na nossa página, e não aparece no schema
público do Orders v2.

## Em aberto

- **Link antigo não é cancelado.** O Orders v2 não cancela pedido não aprovado:
  ele expira sozinho em 6 h. Quando um link novo substitui o antigo (depois de
  1 h), o antigo ainda pode ser aprovado nesse intervalo, e o webhook dele seria
  capturado. É o mesmo risco da InfinitePay. A diferença é que aqui a captura é
  nossa, então dá para fechar: bastaria não capturar pedido cujo
  `PaymentCheckout` está `INACTIVE`. Isso exige o adapter consultar o banco,
  que hoje ele não conhece. Fica para quando acontecer. Vale para o Pix
  também: o QR substituído continua pagável até expirar, e por isso a tela
  dele deixa de mostrá-lo.
- **"Já paguei" não tem limite de frequência no servidor.** Cada clique são
  duas ou três chamadas na conta da igreja; o botão trava enquanto a chamada
  roda, e é só. Um throttle por checkout entra se alguém abusar.
- **Taxas não aparecem na tela.** O PayPal não publica a tabela brasileira numa
  página legível (a oficial bloqueia leitura e as fontes de terceiros divergem),
  então `PROVIDER_PRICING` no front não tem o PayPal. O cartão mostra só os
  métodos aceitos.
- **Nenhuma igreja fechou um ciclo em produção** — selo "Em teste" no front.
