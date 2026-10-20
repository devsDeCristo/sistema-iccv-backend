# Certificado de participação e lista de presença

Código: `src/certificado`. Tela: `ic-front`, aba **Presença e certificados** do
evento (`docs/admin-eventos.md`), botão **Certificado** no ingresso de Minhas
Inscrições (`docs/ingresso.md`) e a página pública `/certificado/:codigo`.

## Quem tem direito

Quem fez **check-in** no evento: o crachá saiu na recepção (`Checkin.status`
diferente de `PENDING` — etapa 1 em diante). Desfazer a entrega do crachá tira
o direito, e o certificado já emitido deixa de ser confirmado na verificação.

## Configuração (`EventCertificate`, tabela `event_certificates`)

Uma linha por evento: `enabled` (desligado, ninguém baixa — nem o painel),
`workload` (carga horária em texto livre, opcional) e `signers` (até duas
pessoas: `{ name, role, signature }`, com a imagem da assinatura em data URI
PNG/JPEG, até ~300 KB).

É salva junto com o evento, no cadastro (`POST /events`) e na edição
(`PUT /events/:id`): o campo `certificate` do multipart, em JSON
(`ConfigurarCertificadoDto`, mapeado por `certificadoParaGravar`), gravado na
mesma transação do evento. Omitido, nada muda; evento que nunca mandou não tem
linha, e vale desligado.

Fica numa tabela à parte, e não em `Event.data`, de propósito: o `data` vai
inteiro para a página pública do evento, e a imagem de uma assinatura não pode
estar ao alcance de qualquer um.

## Rotas

| Rota | Quem | O quê |
| --- | --- | --- |
| `GET /events/:idEvent/certificate` | admin da igreja, admin do evento, super admin | a configuração (para o formulário de edição e a aba de presença) |
| `GET /events/:idEvent/attendance` | idem | a lista de presença, em JSON (não depende do certificado estar ligado) |
| `POST /events/:idEvent/certificates/pdf` | idem | os certificados dos `userIds` do corpo (`CertificadosDosMarcadosDto`: de 1 a 3000), uma página A4 deitada por pessoa, em partes de 50. Quem não fez check-in fica de fora; se ninguém fez, 400. Uma pessoa só: o arquivo leva o nome dela |
| `GET /events/:idEvent/certificates/me/pdf` | qualquer logado | o próprio certificado: precisa estar ligado, a pessoa presente e o evento terminado (o último dia já passou inteiro — `eventoTerminou`). A recusa (403) diz o que falta |
| `GET /certificates/:codigo` | **pública** | a verificação: nome, evento, igreja, período e carga horária — nunca CPF ou contato. Código inexistente, check-in desfeito ou certificado desligado: 404 "Certificado não encontrado" |

As rotas do painel têm `RolesGuard` (`ADMIN_ROLES`), `EventTenantGuard`,
`ModuloGuard` (Eventos no plano) e `@AceitaAdminDoEvento`. Os PDFs saem na
mesma fila do quadrante e dos crachás (`src/pdf/fila.ts`).

## Código de autenticidade

`EventOnUsers.certificateCode` (único), no formato `K7P3-QX9M` — 8 letras de um
alfabeto sem 0/O, 1/I/L (`novoCodigo`). Nasce na primeira vez que o
certificado da inscrição sai e não muda depois: o mesmo certificado baixado de
novo tem o mesmo código. O QR leva a `URL_FRONTEND/certificado/<código>`, e o
código e o endereço vão escritos ao lado dele. A verificação aceita o código
em minúsculas.

## O certificado

A4 deitada, com cara de diploma: papel marfim, letra **Times New Roman** e uma
moldura clássica e contida, na cor do evento (`paletaDoEvento`, a mesma do
quadrante): filete fino por fora, o traço principal e filete fino por dentro,
este com os cantos recortados em curva para dentro. Nos cantos, um losango
pequeno dentro do recorte e um "L" duplo e fino logo para dentro; no meio do
traço de cima e do de baixo, um losango entre dois pontos. A moldura é
desenhada uma vez por documento (`<symbol>`) e cada folha a reusa, para o PDF
de muitos não crescer a cada página.

O Chrome do servidor (Linux) não tem a Times New Roman: lá entra a **Tinos**,
desenhada com as mesmas medidas, embutida do Google Fonts (`embutirFonte`).

Com a logo do evento em cima: "CERTIFICADO *de participação*", "Certificamos que **Nome**
participou do evento **X**, promovido por <igreja>, realizado <período>, com
carga horária de <carga>." Embaixo, as assinaturas (imagem sobre a linha,
nome e cargo) e, no canto, o QR com o código, a data de emissão e o endereço
de verificação. Layout em `certificado-pdf.ts`.

O período sai por extenso (`periodoPorExtenso`): "em 5 de fevereiro de 2027",
"de 4 a 7 de fevereiro de 2027", "de 30 de janeiro a 2 de fevereiro de 2027" —
lido em UTC, como as datas do evento são gravadas.

## A lista de presença

Na tela, não em PDF (`presenca`): todos os inscritos em ordem alfabética, com o
`nomeNoCracha` (nulo quando a pessoa não definiu), a `foto` de perfil, o `tipo` de inscrição e o
`grupo` (com mais de uma inscrição, todas, separadas por vírgula e na ordem
dos grupos; sem nenhuma, "Sem inscrição"/"Sem grupo") e `chegada` — "05/02 às 08:12" (hora da entrega do crachá, horário de
Brasília) ou nula para quem não veio. É dela que o painel gera os
certificados, um a um ou os marcados.

## Minhas Inscrições

`GET /users/:id/payments` traz `certificateAvailable` em cada evento:
certificado ligado, a pessoa com check-in e o evento terminado. É o que mostra o
botão no ingresso.

## Testes

`certificado.spec.ts` (período por extenso, fim do evento, formato do código),
com as regras puras em `certificado-regras.ts` — separadas do serviço para o
teste (e o serviço de pagamentos) não carregarem o Chrome.
