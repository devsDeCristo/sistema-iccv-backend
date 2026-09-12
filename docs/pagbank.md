# PagBank

Este documento registra como a integração PagBank foi estruturada e por que cada decisão foi tomada.

## Visão geral

A integração cria checkouts hospedados pelo PagBank. O backend envia os dados do pedido para a API, recebe o checkout e devolve ao frontend o link de pagamento. O estado do pagamento é atualizado por webhook e por reconciliação periódica.

O adapter principal está em `src/gateways/pagbank/pagbank.gateway.ts` e a comunicação HTTP fica em `src/gateways/pagbank/pagbank.client.ts`.

## Credenciais por igreja

Cada igreja cadastra o próprio token na tela de configurações de pagamentos. O token é:

1. cifrado com AES-256-GCM antes de ser salvo;
2. associado ao `churchId` e ao provedor;
3. aberto somente no momento em que o backend precisa chamar o PagBank;
4. nunca devolvido em claro para o frontend.

A chave que protege esse cofre é `PAYMENT_CREDENTIALS_KEY`. Ela não é o token do PagBank e não autentica chamadas externas. É apenas a chave local usada para proteger os tokens armazenados no banco.

A separação por igreja evita que uma credencial seja reutilizada acidentalmente em outra conta recebedora. O envelope cifrado também é selado com `churchId:provider`, impedindo que um registro seja copiado para outra igreja e aberto com sucesso.

## Ambientes

O modo da integração é salvo com a configuração da igreja:

- `SANDBOX`: `https://sandbox.api.pagseguro.com`
- `PRODUCTION`: `https://api.pagseguro.com`

A credencial precisa pertencer ao mesmo ambiente escolhido. Um token de sandbox enviado para produção, ou o contrário, pode ser recusado pelo PagBank.

A configuração também aceita `baseUrl` opcional para testes controlados. Quando esse campo está vazio, o cliente usa automaticamente a URL oficial correspondente ao modo. O backend valida o host permitido antes de salvar a URL, para evitar que uma credencial seja enviada a um endereço arbitrário.

## Teste da credencial

O botão de teste não cria cobrança nem checkout. Ele consulta um checkout fictício:

```text
GET /checkouts/CHEC_000000000000
```

O resultado esperado para um token válido é `404 checkout_not_found`: o PagBank recebeu a autenticação, mas o checkout fictício não existe. Um `401` ou `403` indica problema de autenticação ou permissão.

Essa escolha substitui o uso de `GET /charges?reference_id=...`. A API do PagBank não trata essa chamada como uma verificação confiável para esse caso e pode responder `406 Not Acceptable`, mesmo quando o token é válido. Consultar um ID de checkout inexistente é barato, não altera a conta e usa um endpoint documentado para leitura.

## Checkout

O checkout é criado com:

- referência interna do pedido;
- dados do cliente;
- itens e valores em centavos;
- métodos PIX, boleto, cartão de crédito e cartão de débito;
- URLs de retorno e de notificação;
- data de expiração.

O backend procura o link cuja relação é `PAY` e envia esse endereço para o frontend. A API do PagBank continua responsável pela coleta dos dados sensíveis de pagamento.

## Webhooks

O PagBank envia notificações para os canais de checkout e pagamento. A integração confere o header `x-authenticity-token`, calculado como SHA-256 de:

```text
<token>-<corpo bruto da requisição>
```

O corpo precisa ser usado exatamente como chegou. Re-serializar o JSON poderia alterar espaços ou a ordem das propriedades e produzir uma assinatura diferente.

Além da assinatura do PagBank, cada configuração possui um segredo próprio na URL do webhook. Esse segredo é armazenado apenas como hash no banco. A combinação reduz o risco de aceitar uma notificação forjada ou destinada a outra igreja.

## Reconciliação e estados

O webhook é o caminho rápido para atualizar o pagamento. A reconciliação consulta as cobranças pelo `reference_id` quando necessário, por exemplo quando uma notificação não chegou.

Quando há mais de uma cobrança para a referência, uma cobrança `PAID` tem prioridade. Sem uma cobrança paga, vale a mais recente. Assim, uma tentativa recusada que chegue depois de uma aprovação não desfaz um pagamento já confirmado.

Respostas `404` indicando recurso inexistente são tratadas separadamente durante a reconciliação. Isso evita transformar a ausência de uma cobrança em erro genérico do sistema.

## Variáveis antigas

`TOKEN_API_PAG_BANK` e `URL_API_PAG_BANK` existiam no modelo anterior, em que havia uma única credencial global no `.env`. O fluxo atual não depende delas para chamadas por igreja. Novas credenciais devem ser cadastradas em Configurações > Pagamentos.

Não versionar tokens, chaves privadas ou valores reais de `PAYMENT_CREDENTIALS_KEY`. Se uma credencial for exposta, ela deve ser revogada no PagBank e substituída na configuração da igreja.

## Referências

- [Documentação de ambientes do PagBank](https://developer.pagbank.com.br/docs/ambientes-disponiveis.md)
- [Consultar checkout](https://developer.pagbank.com.br/reference/consultar-checkout.md)
- [Criar checkout](https://developer.pagbank.com.br/reference/criar-checkout.md)
- [Códigos de status](https://developer.pagbank.com.br/docs/codigos-de-status.md)
