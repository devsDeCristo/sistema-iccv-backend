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
| `enabledMethods` | formas de pagamento: `PIX`, `CREDIT_CARD` ou as duas | não |

As formas são o mesmo campo dos outros gateways (blocos na etapa Pagamento),
com duas diferenças declaradas no adapter:

- **Padrão só o cartão** (`defaultMethods`): a conta PayPal precisa ter o Pix
  habilitado, e oferecer sem isso é dar ao inscrito uma opção que dá erro.
- **`CREDIT_CARD` aparece como "Cartão ou conta PayPal"** (`methodLabels`): a
  página do PayPal junta crédito, débito e saldo, e não dá para oferecer um sem
  os outros.

Só o Pix marcado é válido: o pedido sai direto em Pix, sem perguntar.

Até nov/2026 o Pix era a chave `pix` (`toggle`). O adapter ainda a lê enquanto
`enabledMethods` não foi salvo, e a migração
`20261124200000_paypal_formas_de_pagamento` copia a dica para a tela abrir com o
Pix marcado — a credencial é cifrada e o banco não a altera. Parcelas não são
configuráveis pela API: o parcelamento (2 a 12x sem juros) é ativado na conta
PayPal da igreja.

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

**Testar sempre num navegador sem sessão do PayPal** (outro navegador ou janela
anônima). Quando o navegador já entrou no PayPal antes, ele reconhece a pessoa,
preenche o e-mail e abre no login, ignorando o `GUEST_CHECKOUT` — parece que a
configuração não pegou, mas não é o caso. Confirmado em 12/11/2026: no
navegador com sessão caía no login; em outro, abriu no formulário de cartão.
O inscrito comum não tem essa sessão e vê o formulário.

### O formulário abre preenchido

No Brasil, o pagamento sem login do PayPal é um formulário longo: país,
e-mail, telefone, cartão, endereço de cobrança e, no fim, **criar senha, data
de nascimento e CPF** — o PayPal abre uma conta para quem paga assim, e isso
não tem opção na API para desligar. O que dá para fazer é mandar o que já
temos: `dadosDoInscrito` põe no `payment_source.paypal` o e-mail, nome
(primeiro nome + o resto como sobrenome), CPF (`BR_CPF`), celular, data de
nascimento e endereço do cadastro. Sobra para o inscrito o cartão e a senha.

- Cada campo só vai **completo**: o endereço só com rua, cidade, CEP de 8
  dígitos e UF de 2 letras (cadastro antigo com "Pernambuco" por extenso fica
  sem endereço); CPF só com 11 dígitos; celular com DDD.
- **Preencher é conveniência, não requisito.** Se o PayPal recusar o pedido
  apontando um campo de `/payment_source/paypal/…` (fora o
  `experience_context`), o adapter refaz o pedido sem os dados, com o
  `PayPal-Request-Id` `<referência>-sem-dados` (o primeiro já tem a recusa
  guardada), e deixa no log `PayPal — dados do inscrito recusados em <ref>`.
  Erro em qualquer outro campo sobe como antes.
- A API diz que o `phone` só é usado com a opção **Contact Telephone Number**
  ligada no perfil da conta; sem ela, é ignorado ou recusado — no segundo
  caso, cai na regra acima.
- Não confirmado em produção (12/11/2026): se o formulário do Brasil usa todos
  esses campos ou só parte deles.

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

As etiquetas do cartão do PayPal na tela de pagamentos (`paymentMethods` do
descriptor) são Pix, crédito e débito — o formulário de cartão do PayPal aceita
os dois. A pergunta ao inscrito continua com duas opções (`paymentMethodChoices`:
Pix ou cartão); crédito ou débito ele escolhe na página do PayPal.

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
   [Habilitar na conta](#habilitar-na-conta)), marque **Pix** nas formas de
   pagamento da configuração e pague de novo. A pergunta da forma de pagamento aparece, e
   escolhendo Pix abre a tela do QR. Sem webhook, o botão **Já paguei** da
   própria tela confere no PayPal.

## Pix na tela do sistema

Decisão de 10/11/2026: Pix aqui, cartão no checkout do PayPal. É a única
exceção à regra de "sempre checkout hospedado", e existe porque o PayPal não
hospeda o Pix (a documentação dele diz "QR code (merchant hosted)"). Não há
dado de cartão envolvido.

### A escolha

`PaymentGateway.paymentMethodChoices(ctx)` é opcional, e só este adapter o
implementa: devolve as formas marcadas. Com as duas, o inscrito escolhe; com
uma só, não há pergunta e o serviço a trata como a forma do pedido
(`formaDoPedido`). Isso importa além da criação: o checkout aberto só é
reaproveitado se for da mesma forma, e quando a forma única não voltava, o Pix
já gerado nunca casava — cada clique em "pagar" fazia um QR novo. Em `createCheckout` (serviço de pagamento):

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

E só se ainda for **o que está em vigor** (26/11/2026): da integração que
cobra hoje (`configId`); no Pix, do mesmo tipo — estático da mesma chave
(`mesmaChave`, que ignora valor e identificador), ou do gateway sem estático
ligado; e **cobrando o valor de agora** (`chargedAmountCents` igual ao líquido
de `centavosACobrar` mais a taxa de serviço da forma) — vale para todos os
gateways: desconto dado, produto que saiu por falta de estoque ou taxa trocada
depois de aberto geram um checkout novo, em vez de devolver o link com o valor
velho. Quem abriu o Pix estático, não
pagou e voltou depois que a igreja desligou o estático recebe o Pix do PayPal
(e vice-versa); trocar o código colado também gera um novo. O antigo fica
inativo e a tela dele passa a dizer "substituído". Testes: "Pix aberto volta
só se ainda estiver em vigor", em `src/payment/pix-na-tela.spec.ts`.

### Habilitar na conta

Conta empresarial brasileira, em **Account Settings › Products & Services ›
Payment Methods › Setup Pix**; se a opção não aparecer, o PayPal tem um
formulário de solicitação (links em
`developer.paypal.com/limited-release/alternative-payment-methods/pix/set-up`).
A ativação passa por análise de elegibilidade do PayPal. Há sandbox. O saque do
Pix é para a chave Pix cadastrada, em D+1.

### Pix estático (enquanto o PayPal não libera)

Decisão de 26/11/2026: o PayPal demora (ou recusa) a liberar o Pix da conta, e
a igreja pode colar um **Pix Copia e Cola fixo** da própria conta bancária na
etapa Pagamento (chave "Usar Pix estático", campo `staticPixCode`, declarado
por `campoDePixEstatico()` em `src/gateways/core/pix-estatico.ts`). Com ele
gravado, quem escolhe Pix vê um QR montado a partir desse código e o PayPal
não é chamado; o cartão continua indo para o PayPal como sempre.

- **O QR já vem com o valor e um identificador** (`pixEstaticoComValor`): o
  código colado é o da chave, sem valor; para cada cobrança entram o valor
  exato (campo 54, sem taxa de serviço) e o identificador (62/05, o `txid`:
  nome do inscrito sem acento + 4 caracteres da referência, até 25 — ex.
  `TAILANDAROSA3F9A`), e o CRC é refeito. Quem paga não digita valor, e a
  igreja lê no extrato de quem é a inscrição (quem paga pode ser outra
  pessoa). Alguns bancos não mostram o identificador de Pix estático, e
  alguns apps deixam editar o valor — a baixa continua sendo conferida pela
  igreja.

- **Sem conferência nem baixa.** Nenhum gateway sabe desse pagamento. O
  checkout nasce com `checkoutId = PIX-ESTATICO-<referência>`, e
  `listCharges` responde "não encontrado" sem chamar a API — o mesmo caminho de
  um pedido que o PayPal não conhece: a conferência antes de um checkout novo
  segue em frente, e a cobrança fica **aguardando** até alguém dar baixa pela
  tela de Pagamentos. A reconciliação (rotina e "Conferir no gateway") nem
  pergunta por ele: só enchia o log e, em 24 h, o dava por expirado — e a tela
  passava a dizer "substituído" de um código que não vence.
- **O comprovante vai para os tesoureiros(as) do evento.** Como ninguém fica
  sabendo do pagamento sozinho, a tela do QR (`pixDoCheckout`) devolve
  `comprovantePara: { nome, celular }[]` quando o checkout é estático: os
  `EventTreasurer` do evento e, sem nenhum com celular válido, os
  `EventAdmin`. O celular sai normalizado (DDD + número, `celularBrasileiro`,
  a mesma regra do cadastro no gateway), cada número aparece uma vez só, e o
  próprio inscrito não entra, mesmo sendo tesoureiro(a) ou admin do evento. Fora do estático
  a lista vem vazia; sem ninguém, a tela manda à administração do evento em
  texto. A tela já é recortada ao
  pagamento do próprio inscrito, e só saem nome e celular. A tela mostra um
  botão de WhatsApp para cada um (ic-front, `docs/pagamento-pix.md`).
- **O salvar confere o código** (`problemaNoPixEstatico`): começa em `000201`,
  o CRC16 do fim (`6304` + 4 hex) bate, os campos fecham, e é **o Pix da
  chave, sem valor**. Recusa, cada um com a sua mensagem: código cortado; o
  que não é Pix; **valor fixo** (campo 54 — cobraria o mesmo de todo mundo: a
  tela diz R$ 250 e o banco pede R$ 10); e **Pix de cobrança** (dinâmico, com
  URL no lugar da chave ou `01=12`), que é de uso único — o primeiro paga, os
  outros têm o código recusado.
- **Cada recusa diz o que está errado** (26/11/2026), e não só "cole o código
  inteiro": chave Pix colada no lugar do código; começo diferente de `000201`
  (mostra como começa); final `6304` + 4 faltando (mostra como termina); final
  que não confere com o resto (código alterado ou com parte faltando no meio —
  sem dizer qual seria o final certo, para ninguém "consertar" à mão um código
  mutilado, cujo Pix iria para outra conta); e o campo onde o tamanho deixa de
  fechar, pelo nome ("cidade", "nome do recebedor"…). `limparBrCode` também
  troca o espaço "especial" (U+00A0 e parecidos) que alguns apps põem no lugar
  do comum ao copiar: o texto parecia igual e o CRC não fechava.
- **Código copiado de PDF é consertado no salvar** (`repararBrCode`). Caso
  real (26/11/2026, 6 recusas seguidas): o PDF do banco quebrava a linha no
  meio do nome e a cópia virou espaço — `5904CNI C6009…` no lugar de
  `5904CNIC6009…`. Apagar todos os espaços não serve ("SAO PAULO" tem um de
  verdade); então, quando o código não fecha, tenta tirar cada espaço (depois
  dois, três…, até 10 espaços no código) e grava a versão em que o CRC **e**
  o tamanho de todos os campos batem — as duas coisas juntas não acontecem
  por acaso. Nenhuma fechando, segue para a mensagem de erro. Antes,
  `limparBrCode` tira quebras de linha, tabulação e caracteres invisíveis
  (espaço de largura zero, BOM) — o código copiado de mensagem ou PDF vem
  quebrado, e o CRC não fechava com um código válido. Espaço comum fica.
- **Sem taxa de serviço no Pix:** o dinheiro cai direto na conta da igreja, e
  `taxasDeServico` devolve `pix: 0` com o código gravado.
- **A tela sabe:** a pergunta da forma manda `manualPix: true` (o texto do Pix
  troca "a confirmação sai na hora" por "a organização confere"), e a tela do QR
  recebe `manual: true` (o cabeçalho deixa de dizer "Processado pelo PayPal",
  e somem a contagem, o "Aguardando pagamento" e o "Já paguei" — o código não
  vence na tela, e quem paga não precisa saber como a baixa é feita).
- A chave só aparece com o **Pix marcado** nas formas (é o Pix que ela
  substitui). Desmarcar o Pix desliga a chave e apaga o código; desligar a
  chave também apaga.

Testes: `src/gateways/pix-estatico.spec.ts`.

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
