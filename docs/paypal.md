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

## Pagar sem conta PayPal

O pedido de cartão sai com `landing_page: GUEST_CHECKOUT`: a página do PayPal
abre no formulário de cartão, com "Entrar no PayPal" como alternativa. Sem isso
o PayPal escolhia a tela de login, e quem não tem conta parava ali — visto no
primeiro teste em sandbox (11/11/2026).

Não é garantia: o PayPal só oferece pagar sem conta se a conta que recebe
permitir (*Configurações da conta › Pagamentos no site › Preferências do site ›
Conta PayPal opcional*) e se ele considerar o comprador elegível. Em sandbox,
essa opção é da conta Business de teste, ajustada entrando com ela em
`sandbox.paypal.com`.

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

### "Aguardando" é ignorado

Aviso que, conferido na API, dá "aguardando" — Pix expirado ou cancelado,
cartão recusado na captura — volta `ignored` em vez de virar baixa. Aplicar não
mudaria o status, mas carimbaria a cobrança como vinda do gateway
(`receivedFrom: SYSTEM`), e a tela trava a edição de toda cobrança assim: a
tesouraria não conseguiria quitar à mão quem acabou pagando em dinheiro. Nos
outros gateways "aguardando" pode vir com forma definida (boleto gerado) e
quer dizer cobrança em andamento; no PayPal, sem captura, nunca tem forma.

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

O método sai de `payment_source`: `pix` vira `PIX`; `card` (cartão sem login)
vira `DEBIT_CARD` ou `CREDIT_CARD` pelo `card.type`; a conta PayPal vira
`WALLET` ("Conta digital"). Pela conta, o PayPal não diz se o dinheiro saiu do
saldo ou de um cartão salvo nela: a API de pedidos devolve só a conta, e a de
relatório de transações classifica o mesmo pagamento como "PayPal wallet" — e
ainda leva até 3 horas. **Sem captura o método fica `OTHER`**, de
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

`payment_source.pix` com nome, CPF (só dígitos, `BR_CPF`), e-mail e telefone do
inscrito — com os nomes que a API aceita, que não são os da documentação (ver
abaixo),
`qr_expiry` em segundos (a validade do checkout, dentro dos limites do PayPal:
10 minutos a 72 horas) e `processing_instruction:
ORDER_COMPLETE_ON_PAYMENT_APPROVAL` — **captura automática**. No Pix o dinheiro
já saiu da conta de quem pagou; não há o que revisar, e a regra de "aprovar não
é pagar" lá de cima não se aplica. Se por algum motivo o pedido aparecer
`APPROVED`, `pedidoAtual` captura do mesmo jeito.

A resposta traz o copia e cola no padrão do Banco Central (de onde o QR é
desenhado) e não traz link — **desde que o pedido seja criado com o header
`Prefer: return=representation`**, e não no campo que a documentação diz (ver
as armadilhas abaixo). O adapter devolve
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
   `updatePaymentWebhook`: a conferência de valor vale igual. O `check` só
   pergunta ao PayPal **uma vez a cada 15 s por cobrança**; dentro do
   intervalo devolve o que está no banco. Sem isso, alguém insistindo no botão
   esgotaria o limite de chamadas da conta da igreja (o PayPal responde 429), e
   as baixas dos outros inscritos parariam junto.

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

### A documentação do Pix está errada nos nomes dos campos

**Armadilha já pisada (11/11/2026, produção).** A página de criação de pedido do
Pix manda `email_id`, `phone_number` e `tax_id_type: "CPF"`. A API recusou o
pedido com 400 `INVALID_REQUEST` apontando os três:

| Documentação | O que a API aceita |
|---|---|
| `email_id` | `email` (texto) |
| `phone_number` (texto) | `phone`: `{ country_code: "55", national_number: "<DDD+número>" }` |
| `tax_info.tax_id_type: "CPF"` | `"BR_CPF"` (o `tax_info` padrão da API só aceita `BR_CPF` e `BR_CNPJ`) |

`email` e `BR_CPF` vêm do erro e do schema público. O formato do `phone` é o do
tipo `phone` padrão da API — o erro só disse que faltava o campo, e o Pix não
aparece no schema público. Se ele também for recusado, o log dirá o subcampo.

Quando o PayPal recusa o pedido de Pix (400, 422, 403), o inscrito vê **"O Pix
não está disponível agora. Escolha cartão ou conta PayPal."** (422), e não a
mensagem genérica de "não foi possível falar com o PayPal", que soava como
sistema fora do ar. O detalhe continua no log: `docker service logs
sistema-eventos-iccv_api 2>&1 | grep "PayPal —"`.

### O código do Pix só vem na resposta completa

**Segunda armadilha (11/11/2026, produção, logo depois da primeira).** Com os
campos corrigidos o PayPal criou o pedido, mas o inscrito recebeu "Não foi
possível gerar o link de pagamento em PayPal" (400). O padrão da criação de
pedido é `Prefer: return=minimal`: a resposta traz só `id`, `status` e `links`,
sem `payment_source` — e o `qr_payload` está dentro dele. O exemplo da
documentação do Pix mostra a resposta completa sem dizer que ela precisa ser
pedida.

`PayPalClient.createOrder` manda `Prefer: return=representation` em todo
pedido (no cartão também; o link `payer-action` vem igual).

### O código não vem em `qr_payload`

**Terceira armadilha (11/11/2026, produção).** Com a resposta completa, o
`payment_source.pix` voltou com `name, country_code, currency_code, phone,
email, tax_info, qr_details` — sem o `qr_payload` da documentação, e com um
`qr_details` que ela não menciona nem descreve.

Como o nome do campo de dentro é desconhecido, `codigoDoPix` acha o código
**pelo conteúdo**: o BR Code do Banco Central sempre começa com `000201` (o
indicador de formato do padrão EMV). A busca olha `qr_payload` (se um dia vier)
e tudo dentro de `qr_details`, em qualquer profundidade — e **só** neles: o
resto do `pix` é do inscrito, e um CPF que comece com 000.201 casaria com o
prefixo. O `qr_image` do exemplo deles (`pix://pay?…`) não casa.

Sem código, o inscrito vê a mensagem do Pix indisponível (422), e o log tem
`PayPal — pedido de Pix <id> (<status>) voltou sem o código`, com os campos do
`pix` e o `qr_details` com os textos cortados em 12 caracteres — o formato
aparece, nenhum dado do inscrito. O pedido órfão expira sozinho no PayPal; nada
é gravado aqui.

### A confirmar com uma conta habilitada

- `shipping_preference: NO_SHIPPING` é aceito no Pix (o exemplo deles usa
  `GET_FROM_FILE`); a API não reclamou dele;
- o nome do campo do código dentro de `qr_details`, para trocar a busca pelo
  prefixo por uma leitura direta;
- o texto que começa com `000201` é lido pelos apps de banco;
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
- **O intervalo do "Já paguei" é por processo.** Uma consulta ao PayPal por
  cobrança a cada 15 s (`INTERVALO_DA_CONFERENCIA`), guardada na memória do
  backend. Com mais de uma instância rodando, cada uma conta o seu intervalo;
  aí o lugar dele é o banco ou um Redis.
- **Taxas não aparecem na tela.** O PayPal não publica a tabela brasileira numa
  página legível (a oficial bloqueia leitura e as fontes de terceiros divergem),
  então `PROVIDER_PRICING` no front não tem o PayPal. O cartão mostra só os
  métodos aceitos.
- **Nenhuma igreja fechou um ciclo em produção** — selo "Em teste" no front.
