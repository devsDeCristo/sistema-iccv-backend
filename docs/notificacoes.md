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
| `MEMBERSHIP_ANSWERED` — pedido aceito ou recusado | a pessoa | `MembrosService.aceitar` / `recusar` | `<churchId>:<userId>` |
| `CHURCH_REQUEST` — nova solicitação | admins da igreja | `SolicitacoesService.criar` | a solicitação |
| `CHURCH_REQUEST_ANSWERED` — a situação da solicitação mudou | quem pediu | `SolicitacoesService.mudarStatus`, só quando a situação muda (voltar para "solicitada" não avisa) | `<id>:<status>` |
| `NEWS` — notícia no ar | membros da igreja que publicou; com evento de público, só os membros inscritos ou na lista de espera dele | `NewsService.disparaEmSegundoPlano` — criar publicada, publicar o rascunho e o disparo agendado passam por ali | a notícia |
| `EVENT` — evento aberto ao público | membros da igreja | evento que vira `ACTIVE` (ensaio, `TEST`, não conta): criar, editar e status em massa | o evento |

- **Admin** é o vínculo `UserChurchRole` com `role = ADMIN` nesta igreja. A
  tesouraria não recebe pedido de membro: ela não vê os pedidos em Membros.
  Super admin e dev não recebem (não têm vínculo).
- **Membro** é `User.memberChurchId` desta igreja.
- **Quem fez a ação não recebe o próprio aviso** (o admin que publica a notícia
  e é membro da igreja, o admin que responde a própria solicitação).
- **Os destinatários são os da hora:** quem vira admin ou membro depois não
  recebe as antigas.
- **Uma vez por origem:** `@@unique([type, sourceId])`. A notícia agendada que
  se repete toda semana avisa só na primeira vez; o evento desligado e religado
  não avisa de novo.
- **Nunca derruba a ação:** erro ao notificar vai para o log e o cadastro, a
  solicitação, a notícia ou o evento seguem (`seguro` em `notificar.ts`).
- Notícia do sistema (sem igreja) não notifica ninguém: não tem membros.
- O aviso é histórico: o pedido resolvido continua na lista (lido ou não).

## Banco

- `Notification`: tipo, `sourceId`, título e texto já prontos, `churchId`
  (FK, `Cascade`) e `createdAt`. O texto fica uma vez, por mais membros que a
  notícia tenha.
- `NotificationRecipient`: `(notificationId, userId)`, `readAt` (nulo é não
  lida) e `createdAt` repetido da notificação, para listar as da pessoa só pelo
  índice `(userId, createdAt desc)`. Contagem pelo índice `(userId, readAt)`.
- As duas ficam fora da auditoria (ver [logs-e-auditoria.md](logs-e-auditoria.md)).
- **Limpeza** (cron diário, 4h, [cron.md](cron.md)): apaga o destinatário lido
  há mais de 90 dias e o não lido com mais de 180. A `Notification` fica — é
  ela que impede a mesma origem de avisar de novo.

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

`src/notificacoes/notificacoes.spec.ts`: quem recebe cada aviso, quem fez a
ação fica de fora, uma vez por origem (e por situação na solicitação), evento
só `ACTIVE`, erro não derruba quem chamou, e marcar lida só mexe nas da pessoa.

## Tela correspondente

ic-front, `docs/notificacoes.md`.
