# Mercado Pago

Este documento registra como a integração Mercado Pago foi estruturada e por
que cada decisão foi tomada — em particular as que só se descobrem testando,
porque a documentação deles mudou e a nossa primeira leitura envelheceu.

Para o desenho geral da cobrança — o contrato dos adapters, o cofre de
credenciais, o recorte por igreja e as armadilhas comuns às quatro casas —, ver
[`pagamentos.md`](./pagamentos.md).

## Visão geral

A integração cria **preferências de Checkout Pro**. O backend monta a
preferência com a credencial da igreja, recebe o link e devolve ao frontend. O
inscrito digita os dados de pagamento no site do Mercado Pago; nada de cartão
passa por nós.

- adapter: `src/gateways/mercadopago/mercadopago.gateway.ts`
- HTTP: `src/gateways/mercadopago/mercadopago.client.ts`

## Credenciais

Dois campos, os dois cifrados no cofre por igreja:

| Campo           | O que é                                               | De onde sai                                    |
| --------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `accessToken`   | chave privada, usada no backend para criar a cobrança | Suas integrações › sua aplicação › Credenciais |
| `webhookSecret` | assinatura secreta que valida a notificação           | Suas integrações › sua aplicação › Webhooks    |

### A public key não entra aqui

A tela de credenciais do Mercado Pago entrega **duas** coisas, e só uma nos
serve. A documentação define assim:

> **Public Key:** a chave pública da aplicação é geralmente utilizada no
> frontend. Permite, por exemplo, acessar informações sobre os meios de
> pagamento e criptografar os dados do cartão.
>
> **Access Token:** chave privada da aplicação que sempre deve ser utilizada no
> backend para gerar pagamentos.

A public key serve quando o cartão é digitado **na nossa página** — Checkout
Bricks, checkout transparente — e o SDK do navegador precisa dela para
criptografar o número antes de enviar. O nosso desenho é o oposto: preferência
criada no servidor e redirecionamento. Guardar a public key seria guardar um
segredo que nunca é lido. Se um dia o cartão passar a ser digitado dentro do
sistema, ela entra junto com PCI e tokenização — e aí é outra integração.

O campo na tela diz isso, para a dúvida não nascer de novo com as duas
credenciais lado a lado no painel.

### O prefixo não diz mais o ambiente

**Esta conferência já esteve errada no nosso código e recusava configuração
correta.** A documentação é explícita:

> O _Access Token_ de teste começa com o prefixo `APP_USR`.

É o mesmo prefixo do token de produção. O `TEST-…` é o formato antigo. Enquanto
o `healthCheck` procurava `TEST-` para decidir o ambiente, toda credencial de
teste de hoje era anunciada como "token de produção, mas o ambiente é sandbox",
e o admin era barrado com a credencial certa na mão.

O que sobrou é só o que o prefixo ainda prova:

- token `TEST-…` em **produção** → erro; aquilo é de teste, ponto.
- qualquer outro caso → **não dá para afirmar nada**. O teste de conexão devolve
  a conta conectada (`nickname`/`email` do `GET /users/me`) e, em sandbox,
  acrescenta que o token não se declara — quem reconhece se aquela é a conta de
  teste do vendedor é o admin.

Não existe campo na API que diga "esta credencial é de teste". A conta conectada
é a evidência disponível.

## Ambientes

**Uma URL só para os dois**: `https://api.mercadopago.com`. Quem separa sandbox
de produção é a credencial, não o endereço — por isso não há mapa de bases aqui
como nas outras casas.

Na resposta da preferência vêm dois links. Em `SANDBOX` usamos
`sandbox_init_point`, com `init_point` como reserva: o Mercado Pago nem sempre
devolve o primeiro, e mandar o inscrito para um link vazio seria pior do que
mandá-lo para o checkout normal — que, com credencial de teste, é um checkout de
teste de qualquer forma.

## Checkout

A preferência leva referência interna, itens, dados do pagador, `back_urls`,
`notification_url` e janela de expiração. Dois detalhes que já custaram caro:

- **`unit_price` é em reais**, não em centavos. É a única das quatro casas
  assim. Trocar as duas coisas cobra cem vezes o valor certo.
- **`X-Idempotency-Key` é a nossa referência.** O Mercado Pago devolve a
  preferência já criada quando a mesma chave chega de novo, e é isso que impede
  que o duplo clique no botão de pagar abra duas cobranças para a mesma
  inscrição.

Cancelar não existe no vocabulário deles: o que existe é a janela de validade.
`inactivateCheckout` fecha a preferência empurrando `expiration_date_to` para
ontem — sem isso o link antigo de um checkout substituído continuaria pagável.

## Webhooks

### A assinatura

`x-signature: ts=<carimbo>,v1=<hmac>`, HMAC-SHA256 sobre o texto:

```text
id:<data.id>;request-id:<x-request-id>;ts:<carimbo>;
```

O id entra em **minúsculas** quando tem letras; a documentação é explícita e a
assinatura não bate sem essa normalização.

O corpo **não** entra na assinatura. O que o Mercado Pago autentica é o ponteiro
para o pagamento, não o conteúdo — e é por isso que `parseWebhook` vai buscar o
status na API com a nossa credencial em vez de acreditar no corpo.

### Onde o endereço é cadastrado

O `notification_url` vai dentro de cada preferência. Ainda assim **o endereço
precisa ser cadastrado no painel**, e isso é uma diferença das outras casas —
ver `PROVIDER_WEBHOOK_SETUP` no front, onde o Mercado Pago é
`por-cobranca-e-painel`.

No painel, em Webhooks › Configurar notificações, há **duas URLs**:

> **URL modo teste:** fornece uma URL que permite testar o correto funcionamento
> das notificações dessa aplicação durante a fase de teste ou desenvolvimento.
>
> **URL modo produção:** fornece uma URL para receber notificações com sua
> integração produtiva.

A **assinatura secreta é uma por aplicação**, não uma por modo: mudar de
ambiente não exige trocar o `webhookSecret` cadastrado aqui.

Duas coisas para não repetir:

- **A URL cadastrada é a completa**, com caminho, segredo e canal
  (`…/webhooks/mercadopago/<segredo>/payments`). Cadastrar só o domínio faz o
  Mercado Pago bater na raiz do site — e o sintoma disso é idêntico ao de
  "gateway não avisou": a cobrança simplesmente não dá baixa. A tela de
  configurações mostra o endereço pronto para copiar.
- **Um timeout no simulador não é a nossa aplicação recusando.** Recusa nossa
  responde `404` em milissegundos. Timeout quer dizer que o Mercado Pago está
  batendo num endereço que não atende — URL errada, ou túnel fora do ar.

### O sandbox não notifica pagamento de verdade

**Esta é a descoberta mais cara deste documento.** Medido aqui, com o inspetor
do ngrok e o banco na mão:

| Origem                                                | Chegou?                                     |
| ----------------------------------------------------- | ------------------------------------------- |
| Simulador do painel                                   | sim — assinatura confere, respondemos `200` |
| Pagamento real de teste (cartão, credencial de teste) | **nenhuma requisição**                      |

As páginas de notificação do Mercado Pago dizem que pagamento criado com
credencial de teste não envia notificação, e que a forma de testar recebimento é
a configuração em Suas integrações — ou seja, o simulador. Não consegui abrir a
página que traz essa frase para citá-la literalmente (devolve 404), então ela
fica registrada como "a documentação afirma, e o nosso experimento concorda".

Consequência prática: **em sandbox, a baixa automática do Mercado Pago chega
pela reconciliação, não pelo webhook.** Não é defeito nosso, e não adianta
procurar um. O simulador prova a cadeia; o pagamento de verdade prova a
reconciliação.

## Reconciliação

`listCharges` busca por `external_reference` em `/v1/payments/search`, ordenado
do mais antigo para o mais novo. Lista vazia vira
`GatewayResourceNotFoundError` — o mesmo caso que o PagBank responde com 404 —
para que quem chama distinga "ninguém tentou pagar" de "a casa está fora do ar".

Como em sandbox o webhook não vem, a reconciliação é o caminho normal aqui. Ela
roda de 3 em 3 horas, e existe um botão **Conferir no gateway** na aba
Financeiro do evento que dispara a mesma rotina sob demanda, recortada àquele
evento. O botão é **só do perfil dev**, na tela e na rota: cada clique fala com
o gateway uma vez por cobrança pendente, e numa fila grande um clique repetido
vira uma rajada de chamadas na conta da igreja.

## Erros que parecem defeito e não são

### "Uma das partes com as quais você está tentando efetuar o pagamento é de teste"

Vendedor e comprador precisam ser do mesmo mundo. Com credencial de teste, o
vendedor é de teste — então o comprador também tem que ser. Pagar logado com a
conta real do Mercado Pago produz exatamente essa mensagem.

O caminho, conforme a documentação:

1. Suas integrações › **Contas de teste**: crie uma de Vendedor e uma de
   Comprador.
2. Abra o link numa **janela anônima** (a documentação insiste, para não
   misturar sessões).
3. Entre com **usuário e senha** da conta de teste — a conta de teste **não tem
   e-mail nem CPF** para digitar; o login é o _usuário_ gerado, e ele vai no
   mesmo campo que pede e-mail/CPF. Se o login pedir código enviado por e-mail,
   o código de 6 dígitos está no próprio painel de contas de teste.
4. Pague com cartão de teste — Mastercard `5480 8328 0103 3311`, CVV `123`,
   validade `11/30` — e no **nome do titular** escreva `APRO` para aprovar,
   `OTHE` para recusar, `CONT` para pendente.

### Código da transação em branco no painel

Sintoma que apareceu primeiro no Mercado Pago, mas o defeito era de todos: a
reconciliação gravava em `Payment.payload` o **objeto cru** do gateway, enquanto
o webhook gravava o payload traduzido — o que tem `codeTransaction`,
`payment_method` e `receipt`. Como aqui o webhook não chega em sandbox, todo
pagamento passava pela reconciliação e chegava ao painel sem código.

A tradução subiu para `GatewayCharge.payload`, montada no adapter junto com
status e valor, e os dois caminhos de baixa gravam o mesmo campo. Linhas
gravadas antes dessa mudança continuam com o payload cru: a rotina pula quem já
está com o status certo, então nada as reescreve.

## Referências

- [Credenciais](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/credentials)
- [Contas de teste](https://www.mercadopago.com.br/developers/pt/docs/your-integrations/test/accounts)
- [Realizar compras de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/integration-test/test-purchases)
- [Webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/additional-content/your-integrations/notifications/webhooks)
- [Prefixo do Access Token de teste](https://www.mercadopago.com.br/developers/pt/docs/qr-code/test-integration)
