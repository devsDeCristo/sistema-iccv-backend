# Usuários

Cadastro, perfil e edição de pessoas do sistema. Cobre o cadastro público, a
tela "meu perfil" (`/users/me`), os campos do formulário, dados sensíveis com
consentimento (LGPD) e o que o admin pode editar de outra pessoa. Tela
correspondente no `ic-front`: `docs/login-e-cadastro.md`, `docs/perfil.md` e
`docs/usuarios.md` (painel de gestão).

## Cadastro

- **Rota:** `POST /users`, pública.
- **Perfil e igreja nunca vêm do corpo:** quem se cadastra sozinho nasce
  `Role.USER` (5) e sem vínculo de igreja, mesmo que o corpo mande `role` ou
  `churchRoles` — esses campos são descartados antes de gravar. Promoção de
  perfil só acontece pelo painel (`PUT /users/:id`, por admin).
- **Senha no cadastro:** se a pessoa escolheu uma senha, ela vai com hash
  bcrypt; se não veio, o cadastro fica com a senha padrão fixa do sistema
  (usada nos cadastros feitos pelo painel, até a pessoa redefinir).
- **Aceite dos termos:** `acceptedTerms: true` no corpo grava o aceite da
  versão vigente dos Termos de Uso, com IP e aparelho de quem cadastrou. Ver
  `docs/termos.md`.
- **CPF único:** CPF repetido responde `409 Conflict`.
- **E-mail sem repetido novo:** guardado sempre em minúsculas e sem espaço
  nas pontas (`normalizarEmail`, aplicado no `UserDTO`, que serve ao cadastro,
  à edição pelo painel e ao `PUT /users/me`). Cadastrar ou **trocar para** um
  e-mail que já é de outro cadastro responde `409` com `EMAIL_EM_USO`
  (`emailEmUso`).
  - **Só no código, por enquanto:** há e-mails repetidos antigos em produção,
    então o banco não tem índice único (só um índice comum, para a busca). A
    migração `20261010120000_google_login` só passa os e-mails existentes para
    minúsculas. Duas gravações no mesmo instante com o mesmo e-mail passam; o
    índice único entra quando os repetidos antigos forem resolvidos. Para
    listá-los: `SELECT email, count(*) FROM users GROUP BY 1 HAVING count(*) > 1;`
  - **Quem já divide o e-mail** com outro cadastro continua salvando o resto
    dos dados: a checagem só vale quando o e-mail muda.
  - O login com Google não entra pelo e-mail quando ele é de mais de um
    cadastro (ver `docs/autenticacao.md`).
- **Retorno:** `access_token` (login automático) e o usuário sem o hash da
  senha.

Arquivos: `src/user/user.controller.ts`, `src/user/user.service.ts`,
`src/user/dto/user.dto.ts`.

## `/users/me` — o próprio cadastro

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/users/me` | o próprio cadastro completo |
| `PUT` | `/users/me` | edita o próprio cadastro |
| `POST` | `/users/me/profile-photo` | troca a própria foto |

`GET`/`PUT /users/me` sempre agem sobre o id do token — não há parâmetro na
rota para ler ou editar outra pessoa por aqui.

### O que `PUT /users/me` recusa

- **`role` e `churchRoles`:** ignorados. Perfil de acesso só muda pelo painel.
- **`churchId`:** ignorado (é só a lente de filtro da listagem de admin).
- **`password`:** ignorado. Senha tem rota própria
  (`POST /auth/password/change`), que confere a atual antes.
- **`acceptedTerms`:** ignorado. Aceite é gravado por `POST /terms/accept`.
- **`cpf`:** não pode ser trocado por aqui — é a identidade de login. Corpo
  com CPF diferente do gravado responde `403` pedindo para falar com a
  organização.
- **`email`:** trocar exige `currentPassword` no corpo (mesma trava de 5
  erros/15 min de `conferirSenhaAtual`, ver `docs/autenticacao.md`). Sem a
  senha atual, `400`. É por este e-mail que chega a redefinição de senha —
  trocá-lo sem confirmar a senha abriria uma porta para tomar a conta a
  partir de um navegador esquecido aberto.

## Campos do cadastro

| Campo | Tipo | Observação |
| --- | --- | --- |
| `fullName`, `email`, `cpf`, `birthday`, `cellphone` | obrigatórios | CPF é único; e-mail em minúsculas e sem repetido novo (ver Cadastro) |
| `city`, `state`, `neighborhood`, `profession`, `worker` | obrigatórios | — |
| `street`, `number`, `zipCode` | opcionais | endereço; nasceram depois de cadastros já em produção |
| `congregation` | opcional, texto livre | igreja que a pessoa frequenta — **não** é uma `Church` cadastrada no sistema |
| `pastorName` | opcional, texto livre | pastor da congregação da pessoa |
| `guardianName` | opcional | nome do responsável, para menor de 16 anos; o telefone do responsável usa o mesmo campo `emergencyContact` |
| `emergencyContact` | opcional | contato de emergência (ou telefone do responsável, se menor) |
| `leadershipPosition`, `indicatedBy`, `badgeName`, `notes` | opcionais | — |
| `religion`, `diabetes`, `hypertensive` | opcionais, **sensíveis** | ver seção abaixo |

Arquivo: `prisma/schema.prisma` (`model User`), `src/user/dto/user.dto.ts`.

## Dados sensíveis e consentimento

`src/user/dados-sensiveis.ts`. Saúde (`diabetes`, `hypertensive`) e religião
(`religion`) são dados sensíveis pela LGPD (art. 11) e só existem no banco com
o consentimento específico e destacado do titular — o aceite geral dos Termos
de Uso não basta.

- **`sensitiveDataConsent: true`:** grava o que veio no corpo e marca
  `sensitiveConsentAt` (mantém a data original se já havia consentimento).
- **`sensitiveDataConsent: false`:** revoga — apaga `religion`, `diabetes`,
  `hypertensive` e `sensitiveConsentAt`, mesmo que o corpo também mande
  valores novos para esses campos.
- **Omitido:** o consentimento não é mexido. Se já havia consentido, grava o
  que veio no corpo; se nunca consentiu, os três campos são descartados
  silenciosamente (não gravam).
- Texto vazio em `religion` vira `null` ("não informado").
- A mesma regra vale nos três caminhos que tocam esses campos: cadastro,
  edição (`PUT /users/:id`, `PUT /users/me`) e aceite dos termos
  (`POST /terms/accept`, que pode carregar a decisão junto).
- **Cadastros antigos:** quem já tinha saúde/religião gravada antes de o
  consentimento existir não teve nada apagado pela migração —
  `GET /terms/status` sinaliza `precisaDecidirDadosSensiveis` para essas
  pessoas decidirem.

## Vínculos por igreja (`churchRoles`)

Só admin edita. Regras em `UserService.resolveVinculos`:

- Cada vínculo é `{ churchId, role }`, com `role` limitado a `ADMIN` (2) ou
  `FINANCE` (3) — outro valor responde `400`.
- Uma igreja não pode aparecer duas vezes na lista (`400` se repetida).
- Toda igreja citada precisa existir (`400` senão).
- **Super admin:** define a lista inteira, substituindo os vínculos atuais.
- **Admin comum:** só mexe nas igrejas que ele próprio administra. Vínculos da
  pessoa em igrejas fora do seu alcance são preservados como estavam — um
  admin de uma igreja não apaga, mesmo sem querer, a permissão que alguém tem
  na igreja vizinha. Admin sem nenhuma igreja administrada responde `403` ao
  tentar dar permissão.
- Gravar `churchRoles` recalcula `User.role` (o perfil efetivo) na mesma
  transação.

## O que o admin pode editar

`PUT /users/:id`, autenticado (`JwtAuthGuard`), regra no service:

- **Usuário comum:** só edita o próprio cadastro (id do token = `:id`), e só
  pela tela de perfil (`PUT /users/me`) — usar `PUT /users/:id` diretamente
  para o próprio id responde `403` pedindo para usar a tela de perfil (evita
  trocar CPF/e-mail sem a validação de `updateMe`).
- **Quem alcança o cadastro de quem (`assertUserInScope`, `assertCanReachUser`):**
  - **ler** (`GET /users/:id`, `/users/:id/groups`): admin e financeiro das
    igrejas da pessoa. O financeiro **não recebe saúde nem religião**
    (`CAMPOS_SENSIVEIS`, LGPD art. 11); só quem é admin de uma igreja da
    pessoa, o super admin/dev ou o próprio titular recebem;
  - **alterar** (`PUT /users/:id`, foto): só quem é **admin** de uma igreja
    da pessoa. Quem é admin na A e financeiro na B não edita quem só tem
    relação com a B. Até 09/10/2026 o escopo de edição e da foto incluía as
    igrejas onde ele era só financeiro;
  - fora disso, `403` ("Este usuário é de outra igreja").
- **Grupos da pessoa (`GET /users/:id/groups`):** para o painel, só os de
  eventos das igrejas de quem pede (antes vinham os de todas, com o link do
  WhatsApp). O link nunca sai nos grupos da lista de espera.
- **Campo `role` só é considerado se quem edita for admin.** Para os demais,
  `role` e `churchRoles` são descartados do corpo antes de gravar (o
  formulário de perfil manda o objeto inteiro de volta).
- **Conta Dev:** só outro Dev mexe nela — em qualquer campo, não só `role`.
  Vale para editar dados, trocar foto e mudar permissão; protege contra tomar
  a conta trocando e-mail e pedindo redefinição de senha por fora da trava de
  perfil.
- **E-mail e CPF de quem tem painel em outra igreja:** quem não é super admin
  só troca o e-mail ou o CPF de outra pessoa com vínculo de painel
  (admin/financeiro) se administrar **todas** as igrejas dela
  (`assertAdministraTodasAsIgrejasDe`); senão, `403`. Os outros campos
  continuam editáveis dentro do escopo.
  - **Por quê (09/10/2026):** estar no escopo basta para ter a pessoa inscrita
    num evento da igreja, e o próprio admin pode inscrever alguém pelo id. O
    admin da igreja A trocava o e-mail de um admin da igreja B, pedia
    "esqueci a senha" e assumia a conta: o código ia para o endereço novo.
- **Troca de e-mail feita por outra pessoa avisa o endereço antigo** (modelo
  `email-changed`, com o endereço novo mascarado: `fu***@gmail.com`). Vale
  para qualquer conta, inclusive de usuário comum. Falha de envio não desfaz a
  troca; fica no log.
- **Super admin não é editável por quem está abaixo dele** (só outro super
  admin edita um super admin).
- **Conceder Super Admin:** só quem já é super admin concede.
- **Conceder Dev:** só quem já é Dev concede (super admin não pode criar Dev).
- **`role`** só aceita `DEV`, `SUPER_ADMIN` ou `USER` nesta rota — Admin e
  Financeiro são definidos por igreja em `churchRoles`, não pelo perfil
  global.

## Foto de perfil

- `POST /users/me/profile-photo` (a própria) e `POST /users/:id/profile-photo`
  (de outra pessoa, se autorizado).
- Aceita apenas JPG, PNG ou WebP, até 5 MB (`400` caso contrário).
- A permissão é conferida **antes** do upload (`assertPodeTrocarFoto`): evita
  que alguém sem acesso suba um arquivo no storage em nome de outra pessoa e
  só então leve `403`.
- Mesma trava de conta Dev: só Dev troca a foto de um Dev.

## Listagem (`GET /users`) e insights

- Só `ADMIN_ROLES`. Filtra por `fullName`, `email`.
- Recorte por igreja: cada admin só vê pessoas da(s) sua(s) igreja(s); super
  admin vê todas ou usa `churchId` como "lente" (olhar como se fosse admin
  daquela igreja).
- `GET /users/insights` traz totais (usuários, admins, recorrência em eventos
  do ano anterior) no mesmo recorte.

## Consentimento pendente no código

Em `src/user/user.controller.ts`, o endpoint que criava a relação
usuário-evento diretamente (`POST /:idUser/event/:idEvent`) está comentado no
código, não removido — a inscrição em evento hoje passa só por
`EventService`. Vale confirmar se ainda é necessário mantê-lo comentado ou se
pode ser apagado.
