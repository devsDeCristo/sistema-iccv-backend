# Notificações

O sininho da barra do topo. Uma notificação nasce quando algo acontece (um
pedido, uma solicitação, uma notícia no ar) e vai para quem precisa saber —
calculado no backend, pela igreja do recurso. Cada pessoa lê as suas uma a uma.

E-mail, push e tempo real (socket) ainda não existem: o sininho pergunta a cada
minuto.

## Os avisos

| Tipo (`NotificationType`) | Quem recebe | Onde nasce | `sourceId` |
| --- | --- | --- | --- |
| `MEMBERSHIP_REQUEST` — novo pedido de membro | admins da igreja pedida | cadastro com `requestedChurchId` (`UserService.create`) | o usuário |
| `MEMBERSHIP_ANSWERED` — pedido aceito ou recusado | a pessoa | `MembrosService.recusar` e `tornarMembro` — este cobre aceitar, adicionar pela busca e a planilha de dízimos, quando a igreja é a que ela pediu | `<churchId>:<userId>` |
| `CHURCH_REQUEST` — nova solicitação | admins **e tesouraria** da igreja (os dois entram no painel de Solicitações, e aprovar pede a tesouraria) | `SolicitacoesService.criar` | a solicitação |
| `CHURCH_REQUEST_ANSWERED` — a situação da solicitação mudou | quem pediu | `SolicitacoesService.mudarStatus`, só quando a situação muda (voltar para "solicitada" não avisa) | `<id>:<status>` |
| `NEWS` — notícia no ar | membros da igreja que publicou; com evento de público, quem está nele (inscrito ou na lista de espera), de qualquer igreja — a regra do mural | `NewsService.disparaEmSegundoPlano` — criar publicada, publicar o rascunho e o disparo agendado passam por ali | `<id>:<publishedAt>` |
| `EVENT` — evento aberto ao público | membros da igreja | evento que vira `ACTIVE` (ensaio, `TEST`, não conta): criar, editar e status em massa; e a igreja que sai da implantação (`ChurchService.update` → `notificarEventosDaIgreja`, eventos abertos que não acabaram) | o evento |

- **Admin** é o vínculo `UserChurchRole` com `role = ADMIN` nesta igreja. A
  tesouraria não recebe pedido de membro: ela não vê os pedidos em Membros.
  Super admin e dev não recebem (não têm vínculo).
- **Membro** é `User.memberChurchId` desta igreja.
- **Quem fez a ação não recebe o próprio aviso** (o admin que publica a notícia
  e é membro da igreja, o admin que responde a própria solicitação).
- **Os destinatários são os da hora:** quem vira admin ou membro depois não
  recebe as antigas.
- **Uma vez por origem:** `@@unique([type, sourceId])`. O evento desligado e
  religado não avisa de novo; a notícia avisa uma vez por publicação — tirar do
  ar e voltar não repete, mas cada disparo agendado é publicação nova (volta ao
  topo do mural) e avisa de novo. Dois disparos da mesma origem ao mesmo tempo
  batem no índice, e o segundo é ignorado sem ir para o log como erro.
- **Igreja em implantação** (`ChurchStatus.TEST`) esconde os eventos dela do
  público: o evento aberto lá não avisa, e o aviso sai quando a igreja deixa a
  implantação.
- **Nunca derruba a ação:** erro ao notificar vai para o log e o cadastro, a
  solicitação, a notícia ou o evento seguem (`seguro` em `notificar.ts`).
- Notícia do sistema (sem igreja) não notifica ninguém: não tem membros.
- **Pedido de membro resolvido sai do sininho dos admins**
  (`encerrarPedidoDeMembro`): aceito, recusado, ou a pessoa entrou como membro
  por outro caminho (inclusive em outra igreja). O aviso levaria a uma aba onde
  o pedido já não está. Os demais avisos são histórico e ficam.

## Banco

- `Notification`: tipo, `sourceId`, título e texto já prontos, `churchId`
  (FK, `Cascade`) e `createdAt`. O texto fica uma vez, por mais membros que a
  notícia tenha.
- `NotificationRecipient`: `(notificationId, userId)`, `readAt` (nulo é não
  lida) e `createdAt` repetido da notificação, para listar as da pessoa só pelo
  índice `(userId, createdAt desc)`. Contagem pelo índice `(userId, readAt)`.
- As duas ficam fora da auditoria (ver [logs-e-auditoria.md](logs-e-auditoria.md)).
- **Limpeza** (cron diário, 4h, [cron.md](cron.md)): apaga o destinatário lido
  há mais de 90 dias e o não lido com mais de 180. A `Notification` fica mais —
  é ela que impede a mesma origem de avisar de novo —, e sai quando não tem mais
  destinatário e passou de um ano (o evento religado depois disso avisa de
  novo).

## Rotas (`/notificacoes`, qualquer logado)

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/notificacoes/nao-lidas` | `{ naoLidas }` — o que o sininho pergunta a cada minuto |
| `GET` | `/notificacoes` | as 30 mais recentes da pessoa: `{ id, tipo, origemId, titulo, texto, churchId, data, lida }` |
| `POST` | `/notificacoes/lidas` | `{ ids? }` (UUIDs, até 100) marca essas; sem `ids`, todas as não lidas |

Tudo filtra por `userId` do token: um id de outra pessoa simplesmente não muda
nada.

## Código

- `src/notificacoes/notificar.ts`: as funções de disparo, uma por aviso. São
  funções que recebem o `prisma` (como `exigirModulo`), não um service: quem
  dispara não precisa injetar nada.
- `src/notificacoes/notificacoes.service.ts`: listar, contar e marcar.

## Testes

`src/notificacoes/notificacoes.spec.ts`: quem recebe cada aviso (a notícia de
evento, de qualquer igreja), quem fez a ação fica de fora, uma vez por origem
(por situação na solicitação, por publicação na notícia) sem erro no log,
evento só `ACTIVE` e fora de igreja em implantação, o pedido de membro atendido
por qualquer caminho de `tornarMembro`, erro não derruba quem chamou, e marcar
lida só mexe nas da pessoa. A saída da implantação está em
`src/church/church.service.spec.ts`.

## Tela correspondente

ic-front, `docs/notificacoes.md`.
