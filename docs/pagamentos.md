# Pagamentos

Este documento registra **por que** a cobrança foi desenhada assim. O código
conta o que ele faz; aqui ficam as alternativas descartadas, as armadilhas já
pisadas e o que continua em aberto — que é o que não dá para deduzir lendo os
arquivos.

Para os detalhes de uma casa específica, ver [`pagbank.md`](./pagbank.md),
[`mercadopago.md`](./mercadopago.md) e [`paypal.md`](./paypal.md).

---

## 1. O problema que isto resolve

O sistema cobrava por uma conta só, do PagBank, com o token no `.env`. Três
coisas não cabiam nesse desenho:

- **Cada igreja tem a própria conta bancária.** Com um token global, o dinheiro
  de toda inscrição caía na mesma conta, independentemente de qual igreja
  promoveu o evento.
- **Trocar de casa exigia deploy.** O token estava no ambiente, não no banco.
- **Ligar e desligar cobrança era tudo ou nada.** Duas variáveis
  (`PAGBANK_PAYMENT_ENABLED` no servidor, `VITE_MODULE_PAYMENT` na tela), as
  duas globais, e nada impedia que discordassem entre si.

---

## 2. Uma interface, cinco gateways

Cada casa de pagamento é um **adapter** que implementa `PaymentGateway`
(`src/gateways/core/payment-gateway.interface.ts`). O resto do sistema nunca
fala com PagBank, Mercado Pago, InfinitePay, Ton ou PayPal — fala com a
interface.

```
src/gateways/
  core/          contrato, registry, helpers compartilhados
  pagbank/       ┐
  mercadopago/   │ um diretório por casa: client (HTTP) + gateway (tradução)
  infinitepay/   │
  ton/           │
  paypal/        ┘
  gateways.module.ts   ← o único arquivo a editar para acrescentar uma casa
```

**Sempre checkout hospedado.** Nenhum adapter coleta dado de cartão. O sistema
monta o pedido, recebe um link e manda o inscrito para o site da casa. Isso tira
o sistema do caminho do número do cartão — e, com ele, todo um capítulo de
responsabilidade.

**Uma exceção, e ela não envolve cartão: o Pix do PayPal.** O PayPal não hospeda
o Pix — devolve o copia e cola —, então o QR é mostrado numa tela do próprio
sistema, e o inscrito escolhe entre Pix e cartão antes de o checkout ser criado.
Três peças do contrato existem só por isso, todas opcionais e ignoradas pelos
outros quatro gateways: `paymentMethodChoices` (o adapter diz que há escolha),
`HostedCheckoutRequest.paymentMethod` (a forma escolhida) e
`HostedCheckoutResult.pix` (o código, no lugar do link). Ver
[`paypal.md`](./paypal.md#pix-na-tela-do-sistema).

### O adapter declara, a tela obedece

`PaymentGatewayDescriptor` carrega os campos de credencial que a casa exige,
rótulo, ajuda e domínios aceitos. A tela de configurações **desenha o formulário
a partir dessa lista**, e o backend valida contra a mesma lista.

O motivo é manutenção: uma casa nova entra no ar com os campos certos sem tocar
no front nem em DTO nenhum. E a validação não pode divergir do formulário,
porque as duas leem a mesma fonte.

Um campo pode ser `toggle`: vira chave de liga/desliga na tela, vale `'true'`
ou fica ausente, e o backend recusa qualquer outro valor. Hoje nenhum: o
"Aceitar Pix" do PayPal virou o campo de formas.

Dois tipos de campo decidem **o que o checkout oferece** e moram no cofre como
os outros não-secretos (`src/gateways/core/opcoes-de-pagamento.ts`):

- `methods` (chave `enabledMethods`): lista separada por vírgula, só com formas
  que o gateway declarou — o salvar recusa o resto e repetição. Vazio é
  **todas**: integração antiga continua oferecendo o que sempre ofereceu.
- `installmentsMax` (chave `maxInstallments`): inteiro de 1 até o teto do
  gateway (12 nos três). Vazio é o padrão do gateway.

Como cada adapter traduz:

| Gateway      | Formas                                                     | Parcelas                                                                 |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Mercado Pago | `payment_methods.excluded_payment_types` com as desmarcadas (Pix é `bank_transfer`, boleto é `ticket`); saldo em conta não sai | `payment_methods.installments`                                           |
| PagBank      | `payment_methods` só com as marcadas                       | `payment_methods_configs` → `INSTALLMENTS_LIMIT` (texto), só com crédito |
| Ton          | `accepted_payment_methods`; a forma padrão vira a primeira aceita quando o Pix sai; os blocos `credit_card` e `pix` só vão com a forma aceita | as parcelas sem juros de sempre (mesma chave)                            |
| InfinitePay  | a API não aceita                                           | a API não aceita                                                         |
| PayPal       | Pix e "Cartão ou conta PayPal" (`methodLabels`); padrão só o cartão (`defaultMethods`) — ver `docs/paypal.md` | a API não aceita; o parcelamento é configurado na conta PayPal |

O DTO do PagBank chamava o campo de `payment_method_configs`; a API é
`payment_methods_configs`. Ninguém usava, e o nome foi corrigido junto.
Teste: `src/gateways/opcoes-de-pagamento.spec.ts`.

### `allowedHostSuffixes` não é capricho

Campos de URL (o `baseUrl` do PagBank) só aceitam os domínios que o descriptor
lista. Sem isso, um admin — ou quem tomasse a conta de um — apontaria a
integração para um endereço próprio, e o servidor entregaria a credencial da
igreja na primeira cobrança. Pior: passaria a fazer requisições autenticadas
para onde mandassem, alcançando de dentro da rede o que não é alcançável de
fora.

---

## 3. O cofre de credenciais

Credencial de gateway é diferente de senha. Senha o sistema **verifica**, e hash
basta. Credencial o sistema **usa**: o token precisa sair daqui e ir no header da
chamada à API da casa. Então ela tem que voltar em claro, e hash não serve.

O que dá para fazer é garantir que ela só volte para quem tem a chave — e que a
chave não more no mesmo lugar que o texto cifrado.

- **AES-256-GCM**, modo autenticado. Não é CBC de propósito: sem etiqueta de
  autenticação, quem escreve no banco vira bits do texto cifrado e a abertura
  devolve lixo silencioso em vez de erro.
- **Envelope**: `v<versão>.<iv>.<etiqueta>.<texto>`, tudo em base64url. A versão
  é o que permite rotacionar sem parar o sistema.
- **Selo (AAD) `churchId:provider`**. Não fica guardado no envelope, mas a
  abertura só funciona se o mesmo texto for apresentado. É o que impede copiar
  o envelope da igreja A para a linha da igreja B e passar a receber o dinheiro
  dela — sem nunca ter visto a chave.

### `PAYMENT_CREDENTIALS_KEY`

32 bytes, em base64 (44 caracteres) ou hex (64). Qualquer outro tamanho é
**recusado**, sem esticamento silencioso: uma chave curta aceita "com jeitinho"
cifraria sem reclamar com uma fração da força anunciada.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Sem ela o sistema **sobe** e loga um aviso. Inscrição, check-in e quarto seguem
funcionando; só a cobrança fica indisponível. Derrubar o processo levaria junto
três módulos que não têm nada com isso.

**Perder a chave é perder as credenciais de todas as igrejas.** Não são
recuperáveis; cada igreja teria que cadastrar de novo.

Rotação, sem parar o sistema: move a atual para `PAYMENT_CREDENTIALS_KEY_V1`,
gera uma nova em `PAYMENT_CREDENTIALS_KEY`, sobe
`PAYMENT_CREDENTIALS_KEY_VERSION=2`. A nova passa a selar, a antiga continua
abrindo o que já estava guardado — cada envelope carrega a versão que o selou.
Nada precisa ser reescrito no banco.

---

## 4. O recorte por igreja

Esta é a parte que mais custa errar, e por isso ela é conferida em camadas
independentes.

| Camada | Pergunta que responde |
|---|---|
| `RolesGuard` | esta pessoa pode chegar nesta rota **em alguma** igreja? |
| `ChurchTenantGuard` | ela tem esse perfil **nesta** igreja da URL? |
| `EventTenantGuard` | ela tem esse perfil na igreja **deste evento/pagamento**? Ou, em rota com `@AceitaTesoureiroDoEvento()`, é tesoureira **deste** evento? (ver `docs/tesouraria.md`) |
| Selo do envelope | esta credencial é mesmo desta igreja? |
| `filtroDaCasa` | este retorno de gateway pode mexer nesta cobrança? |

Nenhuma das camadas é suficiente sozinha, e é de propósito.

### Quem cobra é a igreja do evento

O `churchId` nunca vem do corpo da requisição. Em `createCheckout` ele sai de
`event.churchId`, lido do banco. O mesmo vale para o valor: preço e desconto
saem de `eventUserRole`, nunca do que o cliente mandou.

### `null` quer dizer coisas diferentes em lugares diferentes

`tenantChurchIds` devolve `null` quando **não há recorte a aplicar**, e isso
cobre dois casos opostos: o super admin (alcança tudo) e o usuário comum (para
quem a pergunta de igreja não se aplica — o catálogo é aberto a ele).

Isso serve para **filtrar lista**. Não serve para **negar acesso**:
`assertChurchAccess` confere o super admin explicitamente e não deixa mais
ninguém atravessar. Ver a armadilha nº 3 mais abaixo.

---

## 4.1. Pix na tela do sistema

Com o Pix marcado nas formas de pagamento, nos gateways **PayPal, Mercado Pago,
PagBank e Ton** o Pix sai do checkout hospedado e é pago na nossa tela
(`/eventos/:id/pagamento/pix/:referenceId`), com **QR dinâmico** criado na API
de pedidos do gateway: valor e validade desta cobrança, e um identificador que
o gateway amarra ao pagamento — é o que dá a baixa automática. As outras formas
seguem no checkout. A InfinitePay fica de fora: a API dela só gera link.

A regra é uma só (`src/gateways/core/opcoes-de-pagamento.ts`):

- `escolhasComPixNaTela`: sem Pix, nada a perguntar; só Pix, `[PIX]` (não é
  pergunta, é a forma do pedido — ver `formaDoPedido`); Pix e mais alguma,
  `[PIX, CREDIT_CARD]`, onde `CREDIT_CARD` quer dizer "o checkout do gateway",
  com o que estiver ligado lá;
- `querPixNaTela`: o pedido sai em Pix quando o inscrito escolheu ou quando é a
  única forma;
- `formasDoCheckout`: o checkout leva as formas ligadas menos o Pix;
- `rotuloDoCheckout`: o nome da outra saída na pergunta (`choice.checkoutLabel`);
- `pixIndisponivel`: a recusa do gateway na criação vira 422 "O Pix não está
  disponível agora. Escolha outra forma de pagamento." — o caso comum é a conta
  sem chave Pix, que no checkout só escondia o Pix.

| Gateway      | Cria                                                                      | Código                                        | Consulta e aviso |
| ------------ | ------------------------------------------------------------------------- | --------------------------------------------- | ---------------- |
| Mercado Pago | `POST /v1/orders` (`type: online`, `payment_method: { id: pix, type: bank_transfer }`, `expiration_time` em ISO 8601) | `transactions.payments[0].payment_method.qr_code` | `GET /v1/orders/{id}` pelo `checkoutId` (`ORD…`); aviso do tipo `order`, que **só chega pela URL do painel** com o evento "Order" marcado — order não tem URL própria |
| PagBank      | `POST /orders` com `charges[].payment_method.type: PIX` (o `qr_codes` do topo é a carteira PagBank, outro produto) | `charges[0].qr_code.text`                     | `GET /orders/{id}` pelo `checkoutId` (`ORDE_…`); o aviso vai para `notification_urls` e, se a busca por referência não achar a cobrança, é confirmado pela order |
| Ton          | o mesmo `POST /orders`, com pagamento `pix` em vez de `checkout`          | `charges[0].last_transaction.qr_code`         | os caminhos de sempre: o pedido tem o nosso `code` |

Pix substituído (o inscrito gerou outro): no Mercado Pago a order é cancelada
(`POST /v1/orders/{id}/cancel`); no Ton o pedido é fechado; no PagBank não há
como cancelar antes de pagar, e o QR vence no prazo dele (1 h).

Testes: `src/gateways/pix-na-tela.spec.ts` (e `opcoes-de-pagamento.spec.ts`
para o checkout sem o Pix).

## 5. Webhooks

`/webhooks/<casa>/<segredo>/<canal>`

**O segredo vai no caminho porque é o único lugar em que ele cabe**: das quatro
casas, nenhuma deixa cadastrar um cabeçalho próprio na notificação — só a URL.

O preço disso é que a URL inteira vira material de credencial: ela aparece em
log de acesso e em histórico de navegador. Por isso:

- o `LoggingInterceptor` apaga o trecho do segredo antes de gravar;
- a tela avisa quem cadastra;
- existe rota para gerar um segredo novo se ele vazar.

O tratamento é sempre em três perguntas, nesta ordem:

1. **De quem é esta URL?** O segredo aponta uma configuração — uma igreja, uma
   casa. Busca por hash **e** provider, então um segredo do PagBank não vale na
   rota do Mercado Pago.
2. **Veio mesmo de lá?** O adapter confere a assinatura. Quem não assina
   (InfinitePay) resolve reconferindo o pagamento na API da própria casa: o
   corpo do POST é tratado como *"vá olhar aquela cobrança"*, nunca como
   *"aquela cobrança foi paga"*.
3. **O que isso quer dizer aqui?** Só então o corpo é traduzido, e sempre com o
   recorte da configuração que se autenticou.

Falha em qualquer etapa responde **404**, nunca 401: a resposta fica igual à de
uma rota inexistente, e quem estiver adivinhando segredo não recebe a
confirmação de que errou por pouco.

### Onde o endereço é cadastrado

PagBank e InfinitePay recebem a URL dentro da própria chamada que cria a
cobrança (`payment_notification_urls`, `webhook_url`), e não há o que fazer em
painel nenhum.

O **Ton** exige cadastro na conta: a API v5 da Pagar.me resolve webhook por
conta, não por pedido.

O **PayPal** também exige cadastro: webhook pertence à aplicação, não ao
pedido. Sem ele a baixa ainda chega, só mais devagar (pela reconciliação) —
ver [`paypal.md`](./paypal.md).

O **Mercado Pago** é os dois. Ele aceita `notification_url` na preferência, mas
o painel tem uma URL separada para modo de teste, e em sandbox é só ela que
recebe qualquer coisa — ver [`mercadopago.md`](./mercadopago.md). Por isso ele é
`por-cobranca-e-painel` no `PROVIDER_WEBHOOK_SETUP` do front, e a tela mostra o
endereço para ele também.

Se um adapter mudar de comportamento aqui, esse mapa tem que mudar junto, ou a
tela manda a pessoa fazer trabalho à toa — ou, pior, fica calada sobre um
cadastro que ela precisa fazer.

### A URL existe antes do primeiro salvar

Os painéis pedem a URL para só então mostrar a assinatura secreta, e a
assinatura é campo do nosso formulário. Se a URL só nascesse no salvar, o
cadastro travava: não dá para salvar sem a assinatura, não dá para ter a
assinatura sem a URL.

`POST /churches/:churchId/payment-providers/:provider/webhook-draft` gera o
segredo e devolve a URL **sem gravar nada**, junto de um `webhookDraft`: o
segredo cifrado pelo cofre, com igreja e gateway no contexto do selo
(`webhook-draft:<igreja>:<gateway>`, separado do selo das credenciais). O
formulário manda esse `webhookDraft` no primeiro `PUT`, e o `salvar` adota o
segredo em vez de gerar outro — a URL que a pessoa colou no painel é a que
passa a valer.

- Rascunho de outra igreja ou adulterado é recusado com `400`. Gerar outro em
  silêncio deixaria no painel uma URL que não existe.
- Integração já gravada ignora o rascunho: o segredo existente é preservado,
  como sempre.
- Para integração já gravada, a rota devolve a URL atual e `webhookDraft: null`.
- Teste: `src/payment-providers/webhook-draft.spec.ts`.

---

## 6. Conferência de valor

Retorno de casa que diz "pago" não é aceito pelo valor de face. `conferirValorPago`
compara o que voltou pago com o que foi cobrado (`chargedAmountCents`, gravado na
criação do checkout):

- pago ≥ cobrado → `PAID`;
- pago < cobrado → `IN_ANALYSIS` e um aviso no log, nunca `PAID`;
- faltando qualquer um dos dois números → passa direto, porque não há o que
  comparar.

Isso nasceu de um buraco real: a InfinitePay não assinava a notificação e o
valor não era conferido, então quem descobrisse a URL quitava a própria
inscrição com um `curl`. Comprovado depois da correção: R$ 0,01 numa cobrança de
R$ 300 vira `IN_ANALYSIS`.

---

### Desconto da inscrição

`EventOnUsersRolesRegistration.discountPercent`: pontos percentuais sobre o
preço do ingresso (12.5 é 12,5%), nulo é sem desconto. Entra só na criação do
checkout (`totalDiscount` em `createCheckout`), não altera `Payment.amount`. Quem
define é o modal de pagamento (`PUT /payments/:paymentId`, campo
`discountPercent` de 0 a 100 com até duas casas; zero grava nulo, ausente não
mexe). Teste: `src/payment/desconto.spec.ts`.

Até nov/2026 era `discountId`, apontando para a tabela `discounts` — global,
sem igreja, com percentual em fração (0.1). A migração
`20261124210000_desconto_em_percentual` copiou o percentual de cada inscrição
(×100) e removeu a coluna, a tabela e a rota `GET /discounts`.

## 6.1. Forma de pagamento e gateway da baixa

Toda baixa feita pelo gateway — aviso, reconciliação, a conferência antes de um
checkout novo e o "Já paguei" do Pix — grava na cobrança três coisas que vêm
dele: o status, a **forma de pagamento** (`method`) e **por qual gateway**
entrou (`Payment.provider`).

- **`provider`** é o gateway do checkout que respondeu, e não o que a igreja
  usa hoje: uma igreja que trocou de gateway tem cobranças pagas pelos dois. É
  a coluna da auditoria (o extrato de cada gateway contra as baixas dele) e
  aparece na trilha como mudança de campo, o que dá nome ao "Retorno do
  gateway" no histórico. Numa cobrança recusada ou estornada, é o gateway que
  recusou ou estornou. **Volta a nulo no lançamento manual** (`ehLancamentoManual`
  em `updatePaymentStatus`): uma cobrança que o gateway tinha recusado e que
  depois foi quitada em dinheiro não pode aparecer na auditoria do extrato do
  gateway. O retroativo (migração `gateway_do_pagamento`) usa o checkout mais
  recente de cada cobrança cuja origem é o gateway.
- Ninguém grava `provider` pela API: nenhum DTO declara o campo, e o
  `ValidationPipe` (`forbidNonWhitelisted`) recusa a requisição que o mandar.
- **`method`** sai do que o gateway informou. `OTHER` tem dois sentidos no
  sistema — forma desconhecida e "ainda não definida" (é por ele que Minhas
  Inscrições sabe que não há cobrança em andamento) —, então pagamento
  confirmado não deve cair nele quando o gateway disse como foi pago:
  - **`WALLET` ("Conta digital")**: saldo ou conta do próprio gateway — conta
    PayPal; `account_money`, `digital_currency` (Linha de Crédito) e
    `digital_wallet` do Mercado Pago;
  - cartão pré-pago do Mercado Pago é débito; cartão de loja da Ton
    (`private_label`) é crédito; cartão sem login no PayPal é crédito ou
    débito pelo `card.type`;
  - o que nenhum mapa conhece continua `OTHER`, mas com aviso no log
    (`metodoNaoMapeado`, com o nome cru que o gateway usou) — e o valor cru
    sempre fica em `payload.payment_method`.
- O retroativo do método (migração `metodo_conta_digital_retroativo`) corrige
  as cobranças já pagas pelo `payload.payment_method.type` gravado na baixa.
  Separada da que cria o `WALLET`, porque o Postgres não deixa usar um valor de
  enum na mesma transação que o criou.

### Ligar e desligar uma integração

`PATCH /churches/:churchId/payment-providers/:provider/enabled` com
`{ enabled }` — é a chave do card na tela, que substituiu o "Usar esta" (a rota
`PATCH .../:provider/default` saiu). **Só uma integração fica ligada por vez**:
ligar torna esta a padrão e `ajustarPadrao` desliga as demais (`enabled` e
`isDefault` falsos), na mesma transação — vale também para o `salvar` com
`makeDefault`. Desligar tira o padrão junto. Não toca em credencial (o `PUT` de
salvar exigiria reenviar os campos e apagaria os não secretos que não viessem). `enabled` só
governa cobrança nova: aviso e reconciliação das cobranças já abertas seguem.
Ligar exige, antes de mexer em qualquer linha:

- **dev, se a integração estiver em sandbox** — vale também para o `salvar`, que
  confere o modo final (o gravado, quando o corpo não manda). Sandbox ligada
  aceita inscrição real e o dinheiro nunca entra; antes, o "Usar esta" deixava o
  admin fazer isso sem passar pela trava do modo;
- **credencial que este ambiente consegue abrir** — ligar uma integração
  cifrada com chave que não está aqui derrubava todo checkout da igreja.

Teste: `src/payment-providers/definir-ativo.spec.ts`.

## 7. Cobrança online por igreja

Substituiu as duas variáveis globais. A igreja cobra com o módulo **Eventos** no plano **e** a cobrança ligada nela (`Church.modulePayment`, que o dev/super admin alterna em `PATCH /churches/:churchId/payment-providers/module`) — ver `docs/planos.md`. As respostas seguem com o nome `modulePayment`, já calculado. Sem cobrança:

- `createCheckout` recusa com **503** antes de qualquer escrita;
- a reconciliação **pula** as cobranças daquela igreja;
- a tela do inscrito esconde tudo que fala de pagamento;
- a tela de configurações esconde a grade de casas.

As credenciais **não** são apagadas: desligar pausa, religar devolve tudo como
estava — que é o caso comum (pausar uma igreja por um mês).

**Quem decide é dev ou super admin**, pelo plano da igreja — não quem administra a igreja. Deixar o admin desligar daria a ele um jeito de parar a reconciliação das cobranças que ele mesmo abriu.

Igreja sem plano não cobra: depois da migração dos planos, nenhuma cobra até receber um plano com Eventos.

---

## 8. Reconciliação

O webhook é o caminho rápido; o cron de 3 em 3 horas é a rede de segurança para
quando a notificação não chega.

Duas decisões que valem registro:

- **O PayPal só consulta pelo id do pedido**, nunca pela referência. Por isso
  `listCharges` recebe também o `checkoutId`, e a rotina o seleciona junto. Os
  outros adapters ignoram o parâmetro.
- **A credencial é a que gerou o checkout** (`configId`), não a que a igreja usa
  hoje. Perguntar o status com a credencial de hoje sobre uma cobrança nascida
  na credencial de ontem daria "não existe", e o pagamento ficaria parado.
- **Uma credencial por configuração, em cache**, não uma por cobrança: sem isso
  a rotina abre o envelope cifrado uma vez por linha pendente.
- **A baixa grava o payload traduzido**, o mesmo do webhook. Ele nasce no
  adapter, em `GatewayCharge.payload`, junto com status e valor. Antes a
  reconciliação gravava o objeto cru da casa, e o painel ficava sem código de
  transação em todo pagamento que o webhook não pegou — sintoma que apareceu no
  Mercado Pago, onde em sandbox o webhook nunca pega.
- **Pedido que o gateway não conhece mais sai da rotina.** Quando a resposta é
  "não existe" (ou lista vazia) e o checkout tem mais de 24 horas, ele vira
  `EXPIRED` e as rodadas seguintes não o consultam. Antes a rotina só avisava e
  seguia, e perguntava pelo mesmo pedido a cada 3 horas, para sempre — visto no
  painel do PayPal como uma fila de `404` no mesmo `GET /v2/checkout/orders`
  (o pedido do PayPal some da API quando expira). As 24 horas existem porque o
  PagBank responde 404 para checkout ainda válido enquanto ninguém pagou.
  Só o checkout expira: a cobrança continua pendente, quem voltar para pagar
  ganha um checkout novo, e um aviso atrasado do gateway ainda dá baixa, porque
  o webhook acha o checkout pela referência, seja qual for o status.

Além do relógio, a rotina tem um gatilho manual: o botão **Conferir no gateway**
na aba Tesouraria do evento, recortado àquele evento e limitado ao perfil dev —
na tela e na rota. Cada clique fala com o gateway uma vez por cobrança pendente.

---

## 9. Armadilhas já pisadas

Cada uma destas custou tempo. Estão aqui para não custarem de novo.

### 1. `Accept: application/json` derruba o PagBank

O `GET /charges?reference_id=` responde **406** com esse cabeçalho. Precisa ser
o curinga. As outras três casas aceitam o específico, que é o padrão do
`criarHttp` — o PagBank é a exceção, e ela está escrita no cliente dele.

Quebrou a reconciliação inteira e **quebrou calada**: todo pagamento pendente
voltava erro de rede e nenhum recebia baixa. Travado por teste em
`pagbank.client.spec.ts`.

### 2. `applyUpdateData` engolindo a trilha de auditoria

O middleware do Prisma tratava qualquer valor-objeto como operador de banco.
Como o webhook grava um campo `payload` em JSON, o `updateMany` dentro da
transação perdia silenciosamente o log e a trilha financeira.

O sintoma era ausência, não erro — ninguém percebe uma linha que não foi
escrita. Travado por teste em `apply-update-data.spec.ts`.

### 3. Guard que falhava aberto

`EventTenantGuard` descobre a igreja pelo evento do pagamento. Quando não
conseguia descobrir, ele **liberava** — e `Payment.eventId` é opcional no
schema. Um admin de qualquer igreja marcava uma cobrança órfã como paga.

Provado contra o servidor antes da correção. Hoje "não consegui descobrir" custa
403. Travado em `event-tenant.guard.spec.ts`.

### 4. `assertChurchAccess` herdando o `null` do usuário comum

Ver a seção 4. A função de **negar acesso** não pode reaproveitar a lógica de
**filtrar lista**. Não era alcançável — toda rota que chega lá declara `@Roles`
—, mas a proteção dependia de ninguém esquecer o decorador numa rota nova.

### 5. `paymentId` aceito pelo corpo

O DTO declarava o campo, e o controller o sobrescrevia com o valor do caminho.
Funcionava, mas era uma linha que dava para esquecer no próximo handler: com
duas fontes para o mesmo id, bastava pôr no caminho um pagamento da própria
igreja e no corpo o de outra.

Hoje o campo não existe no DTO, e o `ValidationPipe`
(`forbidNonWhitelisted: true`) recusa a requisição inteira com 400.

### 6. Retorno do gateway para uma rota que não existe

O `redirectUrl` do checkout — para onde o gateway devolve o inscrito depois de
pagar — era `<front>/events/<id>`. A rota do front é `/eventos/<id>`, e o
coringa do roteador manda o que não existe para o login: todo inscrito que
pagava, em qualquer gateway, voltava para a tela de login em vez do evento.
Corrigido em 10/11/2026. Os outros endereços do front que o backend monta
(`/certificado/<código>` e `/admin/eventos`) foram conferidos contra as rotas.

---

## 10. Em aberto

- **Webhook continua sendo processado com o módulo desligado.** Foi escolha:
  um webhook é prova de que o dinheiro se moveu, e descartá-lo perderia o fato.
  O caso ruim é desligar o módulo de uma igreja com cobrança em aberto. Se a
  decisão mudar, o ponto é `WebhooksService.processar`.
- **Checkout abandonado nunca expira.** Cobrança que nunca virou pedido na casa
  fica `WAITING` para sempre e é consultada a cada 3 horas, indefinidamente.
- **O Ton não recebe notificação até alguém cadastrar a URL** na conta
  Pagar.me. Nenhuma igreja usa o Ton hoje, então não quebra nada agora.
- **No PayPal, o link substituído não é cancelado** (o Orders v2 não oferece) e
  expira sozinho em 6 h. Ver [`paypal.md`](./paypal.md#em-aberto).
