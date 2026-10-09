# Inscrições

Como um usuário entra num evento: vagas por grupo, lista de espera, termo do
evento, aprovação de menor de idade, troca de grupo, remoção e o e-mail de
confirmação. A janela de abertura/fechamento de cada grupo tem regra própria
— ver `docs/inscricao-em-grupos.md` — aqui ela só é citada como um passo
anterior à contagem de vagas.

## Transação e concorrência

Toda inscrição passa por `_registerUserInEventTx`, chamada por
`registerUserInEvent` numa transação `Serializable`: duas pessoas podem
disputar a mesma última vaga do grupo ao mesmo tempo, e sem isolamento forte
as duas leriam "tem vaga" antes de qualquer uma escrever.

- **Retry automático:** conflito de serialização (`40001` cru ou `P2034` do
  Prisma) faz `registerUserInEvent` chamar a si mesma de novo, até **5
  tentativas**.
- **Sem retry com transação externa:** se quem chamou já passou uma `tx`
  (ex.: `updateUserFromEvent`), o conflito já abortou a transação do
  chamador — o erro sobe direto.
- **Vale para a waitlist também:** entrar na lista de espera passa pela
  mesma `_registerUserInEventTx`, sob a mesma trava.

Arquivo: `src/event/event.service.ts` (`registerUserInEvent`,
`_registerUserInEventTx`).

## Vagas e lista de espera

Dentro da transação: checa a janela do grupo (só para quem se inscreve
sozinho), conta uma vez, por grupo pedido, quantas
`EventOnUsersRolesRegistration` já existem, e então processa role por role.

- **Vaga livre:** upsert em `EventOnUsers`, cria a
  `EventOnUsersRolesRegistration` e o `Payment` da inscrição (gratuita nasce
  `PAID`/`CASH`; paga nasce `WAITING`/`OTHER`, aguardando o gateway — ciclo
  completo em `docs/pagamentos.md`).
- **Grupo cheio** (contagem ≥ `capacity`, quando `capacity` não é nulo):
  cria `Waitlist { userId, eventId, roleRegistrationId }` em vez de
  matricular.

### Lista de espera andando

| Rota | Método | Quem pode | Efeito |
| --- | --- | --- | --- |
| `:idEvent/waitlist/users` | GET | `ADMIN_ROLES` | Lista a waitlist, com posição por grupo (`createdAt`/`id`) |
| `:idEvent/waitlist/users/:idUser/rule/:roleRegistrationId` | DELETE | `ADMIN_ROLES` | Remove a entrada, sem mexer em vaga |
| `:eventId/waitlist/move` | PUT | `ADMIN_ROLES` | Move alguém da waitlist para o grupo, liberando a vaga de outro inscrito |

`movedUserFromWaitlistToEvent` (o PUT acima) roda em transação
`Serializable` própria: apaga a entrada da waitlist, remove a role do
usuário que sai do grupo (e a `EventOnUsers` dele, se não sobrar role
nenhuma no evento) e chama `registerUserInEvent` para matricular quem
estava esperando. Sem vaga mesmo assim, desfaz tudo com `400 - Não há vagas
disponíveis no evento para nesse grupo`.

Arquivos: `src/event/event.service.ts` (`findUsersInWaitlist`,
`removeUserFromWaitlist`, `movedUserFromWaitlistToEvent`),
`src/event/event.controller.ts`.

## Uma inscrição por grupo

`_registerUserInEventTx` recusa com `400`:

- **Roles de grupos diferentes:** duas roles do mesmo grupo no pedido →
  "As regras devem pertencer a grupos diferentes".
- **Role repetida:** pedir de novo uma role já registrada → "Usuário já
  registrado em grupos no evento".
- **Grupo já ocupado:** pedir role de um grupo em que a pessoa já tem outra
  role → "Usuário já registrado em uma regra do mesmo grupo neste evento".
- **Já na waitlist para a role:** "Usuário já está na lista de espera para
  algumas regras de grupo no evento".

Roda tudo na mesma transação serializable, então vale também contra uma
segunda inscrição disparada em paralelo.

## Termo do evento

Termo de inscrição vive em `data.registrationTerm` (HTML). `exigeAceiteDeTermo`
(`src/event/event-terms.ts`) decide se ele "existe de verdade" — string
vazia, `<p><br></p>` (caixa usada e apagada no editor) ou HTML sem texto e
sem `img`/`iframe`/`video` não exigem aceite.

- **Quando exige:** só para quem se inscreve a si mesmo. Admin inscrevendo
  outra pessoa não aceita termo em nome de ninguém, e a inscrição sai sem
  `termsAcceptedAt`.
- **Sem aceite:** corpo sem `acceptedTerms: true` num evento com termo →
  `400 - É preciso aceitar os termos do evento para se inscrever`.
- **Gravação:** `EventOnUsers.termsAcceptedAt` recebe a data só quando
  houve aceite nesta chamada — inscrever-se de novo em outro grupo sem
  marcar o termo de novo não apaga o carimbo anterior.

Arquivo: `src/event/event-terms.ts` (`termoDeInscricao`,
`exigeAceiteDeTermo`), testes em `event-terms.spec.ts`. DTO:
`roleEventDto.acceptedTerms`. Tela: `ic-front, docs/inscricao-no-evento.md`.

## Menor de idade e aprovação do responsável

Elegibilidade decidida na hora da inscrição, com a idade **na data de
início do evento** (`event.startDate`), não na data da inscrição.

- **Corte:** `calculateAge(user.birthday, event.startDate) < 16` →
  `MinorApprovalStatus.PENDING`; caso contrário, `NOT_REQUIRED`.
- **`calculateAge`** (`src/utils/age.ts`): idade completa em anos numa data
  de referência qualquer.

| Status | Significado |
| --- | --- |
| `NOT_REQUIRED` | Maior de idade na data do evento — não precisa de termo |
| `PENDING` | Menor; aguardando envio do termo ou revisão do admin |
| `APPROVED` | Admin conferiu o termo e liberou o participante |
| `REJECTED` | Admin recusou o termo — o responsável pode reenviar |

**Envio do termo assinado** — `POST :idEvent/users/:idUser/guardian-term`
(multipart, campo `termFile`), sem `@Roles`: vale para o próprio usuário e
para quem tem permissão de inscrever terceiros (`assertPodeInscrever`). Recusa `404` sem inscrição, `400` se `NOT_REQUIRED`. O
arquivo vira data URI gravado em `signedTermUrl` (sem Storage — cada termo
é um arquivo só). Todo reenvio, mesmo após recusa, volta o status para
`PENDING` e limpa motivo e dados de revisão anteriores.

**Aprovação/recusa** — `PUT :idEvent/users/:idUser/guardian-approval`,
`ADMIN_ROLES`. Corpo `GuardianApprovalDto` (`status`: `APPROVED`/`REJECTED`;
`reason` obrigatório em `REJECTED`). Recusa `400` se `NOT_REQUIRED`, se
`APPROVED` sem `signedTermUrl` gravado, ou se `REJECTED` sem `reason`.
Grava `minorApprovalReviewedById`/`minorApprovalReviewedAt`.

Arquivo: `src/event/event.service.ts` (`uploadGuardianTerm`,
`reviewGuardianApproval`), `src/event/dto/event.dto.ts`
(`GuardianApprovalDto`).

## Troca de grupo

`PUT :idEvent/users/:idUser` (`ADMIN_ROLES`) chama `updateUserFromEvent`:
transação `Serializable` própria que apaga toda `EventOnUsers`/roles da
pessoa no evento e chama `registerUserInEvent` de novo com as novas roles,
na mesma `tx`.

- Se a nova inscrição cair na waitlist em algum grupo, desfaz tudo: `400 -
  Não há vagas disponíveis no evento para o grupo selecionado`.
- Roda com `tx` própria, então não entra no retry automático — conflito de
  serialização aqui sobe direto.

Arquivo: `src/event/event.service.ts` (`updateUserFromEvent`).

## Remoção do inscrito

`DELETE :idEvent/users/:idUser/rule/:roleRegistrationId` (`ADMIN_ROLES`)
chama `removeUserFromEvent`, que apaga em transação, para aquele usuário
naquele evento:

- `PaymentCheckout`/`Payment` **só do ingresso** (`roleRegistrationId`
  preenchido) — compra avulsa da loja fica, é dinheiro já recebido, e o
  checkout dela precisa continuar existindo para o retorno do gateway achar
  a quem dar baixa.
- `BedroomsOnUsers` e `TransportOnUsers` do evento — sai da inscrição, sai
  do quarto e do ônibus.
- `TeamOnUsers` do evento, `Waitlist` do usuário, e por fim
  `EventOnUsersRolesRegistration`/`EventOnUsers`.

A resposta traz a contagem de cada apagamento. Existe também `removeRelation`,
que apaga só a `EventOnUsers` — sem rota no controller chamando-a hoje.

Arquivo: `src/event/event.service.ts` (`removeUserFromEvent`,
`removeRelation`).

## E-mail de confirmação

Depois de inscrição bem-sucedida (exceto ao mover alguém da waitlist, que
não reenvia e-mail), `registerUserInEvent` dispara `sendEmailConfirmation`
**fire-and-forget**: o `.catch` só loga o erro, falha de e-mail nunca
derruba a inscrição.

Contém: um cartão por ingresso/role pedida (grupo, role, status `INSCRITO`
ou `LISTA DE ESPERA`, local do evento), faixa com capa/logo do evento,
data e endereço completo, e assinatura do líder espiritual da igreja
organizadora — sem líder vinculado, sai sem assinatura.

Arquivo: `src/event/event.service.ts` (`sendEmailConfirmation`,
`renderTickets`, `renderEventBanner`, `renderSignature`). Tela relacionada:
`ic-front, docs/minhas-inscricoes.md`.

## Inscrição em nome de outra pessoa (`assertPodeInscrever`)

Vale para inscrever, comprar na loja e anexar termo por outra pessoa
(`POST :idEvent/users/:idUser`, `…/products`, `…/guardian-term`). Para fazer
isso é preciso:

- ter perfil de painel efetivo (`ADMIN_AREA_ROLES`, o perfil calculado dos
  vínculos que valem, e não o gravado);
- a pessoa já estar no cadastro da igreja de quem pede (`userChurchScope`), o
  mesmo recorte da lista de usuários de onde a tela "adicionar pessoa" tira
  quem inscrever. Super admin e dev inscrevem qualquer pessoa.

**Por quê (09/10/2026):** antes bastava o perfil de quem pedia. O admin da
igreja A inscrevia qualquer pessoa pelo id num evento da A e, com isso, a
trazia para o próprio escopo, onde lia o cadastro completo. Foi metade do
caminho da tomada de conta descrita em `docs/usuarios.md`.
