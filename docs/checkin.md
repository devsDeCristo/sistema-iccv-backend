# Check-in

Check-in de recepção do evento: um fluxo de três etapas (crachá → chamada → foto), feito à mão pelo operador buscando o participante por nome, CPF ou número de inscrição. Não há leitura de QR neste módulo — o código do QR do crachá é assunto do módulo de crachás (veja `docs/crachas-e-pdf.md`).

Arquivos: `src/checkin/checkin.controller.ts`, `src/checkin/checkin.service.ts`, `src/checkin/checkin.gateway.ts`, `src/checkin/checkin.module.ts`, `src/checkin/dto/checkin.dto.ts`.

## As três etapas (`CheckinStatus`)

| Status | Significado | Quem grava |
| --- | --- | --- |
| `PENDING` | inscrito que ainda não chegou (não existe linha de `Checkin`, ou ela já foi revertida até aqui) | — |
| `QUEUED` | crachá entregue na recepção; aguardando na fila do posto de foto | `deliverBadge` |
| `IN_PROGRESS` | chamado pelo posto de foto | `call` / `callNext` |
| `DONE` | foto tirada e dados conferidos | `complete` |

Cada etapa grava, no registro `Checkin` (chave única `userId` + `eventId`), o horário e o id do operador que a executou: `badgeDeliveredAt`/`badgeDeliveredById`, `calledAt`/`calledById`, `doneAt`/`doneById`. `notes` guarda a observação do atendimento, e `autoBedroomId` guarda o quarto alocado automaticamente na entrega do crachá (ver abaixo).

## Rotas (`/events/:eventId/checkin`)

Todas as rotas exigem `JwtAuthGuard`, `RolesGuard`, `EventTenantGuard` e o papel de admin (`@Roles(...ADMIN_ROLES)`: dev, super admin ou admin da igreja do evento).

| Método | Caminho | O que faz |
| --- | --- | --- |
| `GET` | `/search` | busca inscritos do evento (query `q`, opcional); sem termo devolve todos |
| `GET` | `/queue` | fila do posto de foto: `waiting` (`QUEUED`) e `inProgress` (`IN_PROGRESS`) |
| `GET` | `/stats` | contadores: `total`, `queued`, `inProgress`, `done`, `pending` |
| `POST` | `/:userId/badge` | Etapa 1 — entrega do crachá; entra na fila |
| `POST` | `/call-next` | Etapa 2 — chama o primeiro da fila |
| `POST` | `/:userId/call` | Etapa 2 — chama um participante específico |
| `POST` | `/:userId/complete` | Etapa 3 — foto tirada e dados conferidos (corpo `{ notes? }`) |
| `POST` | `/:userId/undo` | desfaz a última etapa (uma de cada vez) |
| `POST` | `/:userId/undo-badge` | reverte a entrega do crachá direto para `PENDING`, pulando etapas intermediárias |

## Validações e erros

- **Participante não inscrito no evento:** qualquer etapa passa por `findRegistration`, que busca em `EventOnUsers` pela chave `userId`+`eventId`. Sem inscrição, `404 NotFoundException` ("Participante não inscrito neste evento").
- **Crachá já entregue por outro operador:** `deliverBadge` só avança quem está em `PENDING`; se a linha já mudou (outro operador entregou entre a leitura e a escrita), `409 ConflictException` com quem entregou e a que horas, quando esses dados existem.
- **Corrida na criação do primeiro registro:** se dois operadores entregam o crachá ao mesmo tempo para quem ainda não tinha linha de `Checkin`, o segundo `create` esbarra na constraint única (`P2002`) e recebe `409 ConflictException` ("Outro operador acabou de entregar o crachá deste participante").
- **Chamar quem não pegou o crachá:** `call`/`callNext` só avançam quem está `QUEUED`; sem isso, `409 ConflictException` ("Este participante ainda não retirou o crachá na recepção").
- **Chamar quem já foi concluído ou já foi chamado:** `409 ConflictException`, distinguindo "já foi concluído" de "já chamado por X às hh:mm".
- **Concluir quem não está na fila:** `complete` aceita `QUEUED` ou `IN_PROGRESS`; fora disso, mesmos erros de `call` (não retirou o crachá / já concluído).
- **Fila vazia em `callNext`:** `404 NotFoundException` ("Não há ninguém aguardando na fila").
- **`undo` sem etapa para desfazer:** participante em `PENDING` (ou sem linha) recebe `409 ConflictException` ("Não há etapa de check-in para desfazer").
- **Condição de corrida no `undo`/`undo-badge`:** o `updateMany` filtra pelo status lido antes; se alguém mudou o status nesse meio-tempo, `count` vem `0` e a resposta é `409 ConflictException` pedindo para atualizar a tela e tentar de novo.

Todas essas escritas usam `updateMany` com o status atual no filtro (não `update` por id), justamente para que dois operadores mexendo na mesma pessoa ao mesmo tempo nunca sobrescrevam um ao outro em silêncio — um dos dois sempre cai num dos erros acima.

## Alocação automática de quarto

Na entrega do crachá (`deliverBadge`), se o evento tem o módulo de quartos ativo (`moduloAtivo(evento.data, 'bedrooms')`) e a pessoa ainda não tem quarto, o serviço tenta alocar um automaticamente:

- **Ordem de tentativa:** primeiro os quartos com `groupTags` que batem com algum grupo do participante, depois os quartos abertos (sem `groupTags`); dentro de cada grupo, em ordem alfabética "de gente" (`localeCompare` numérico, então "Quarto 2" vem antes de "Quarto 10").
- **Quarto sem `capacity` definida não entra na lista** — não há como saber se ainda cabe alguém.
- **Trava de linha (`SELECT ... FOR UPDATE`)** evita que dois operadores ocupem a última vaga do mesmo quarto ao mesmo tempo.
- **Falha na alocação não derruba a entrega do crachá:** o crachá continua entregue mesmo se nenhum quarto tiver vaga; o erro só vai para o log.
- **Reversão:** `undo` (de `QUEUED` para `PENDING`) e `undo-badge` liberam a vaga alocada automaticamente (`autoBedroomId`) — um quarto escolhido à mão pela recepção não tem essa marca e não é mexido.

## Canal em tempo real (WebSocket)

Arquivo: `src/checkin/checkin.gateway.ts`. Namespace Socket.io `/checkin`, uma sala por evento (`checkin:{eventId}`).

- **Conexão:** exige um JWT válido no handshake (`auth.token` ou header `Authorization`); sem token válido, o socket é desconectado.
- **`checkin:join` (mensagem recebida):** só entra na sala quem é admin da igreja daquele evento (ou super admin/dev) — a mesma regra de acesso das rotas REST, verificada de novo aqui porque o guard HTTP não roda em WebSocket.
- **`checkin:leave` (mensagem recebida):** sai da sala do evento.
- **`checkin:updated` (evento emitido):** disparado por toda etapa que muda o check-in (`deliverBadge`, `call`, `callNext`, `complete`, `undo`, `undoBadgeDelivery`), com `{ eventId, reason, userId }`. `reason` é só um rótulo (`badge-delivered`, `called`, `completed`, `undone`, `badge-undone`) para a tela decidir se mostra um alerta — o socket **não carrega dados do participante**; a tela reage refazendo a chamada REST correspondente, que continua protegida por `JwtAuthGuard`/`RolesGuard`.

## Relação com o módulo de crachá

O check-in **não lê QR code**: a busca é sempre manual, por nome/CPF/número de inscrição (`GET /search`). Não há nenhuma referência cruzada em código entre `src/checkin` e `src/cracha`.

O código do QR impresso no crachá é gerado pelo módulo de crachás (`codigoDoCracha`/`qrDoCracha` em `src/cracha/cracha-pdf.ts`): o id do inscrito em hexadecimal maiúsculo, sem hífen (32 caracteres `[0-9A-F]`), no mesmo formato que o leitor do front espera (`buildBadgeCode`). Esse é um recurso do front (leitura de câmera), não deste módulo do backend — detalhes da geração do PDF e do QR estão em `docs/crachas-e-pdf.md`.

## Tela correspondente

Front (`ic-front`): `docs/checkin.md`.
