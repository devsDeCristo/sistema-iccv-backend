# Autenticação

Módulo de login, sessão e recuperação de senha do sistema. Cobre também os
perfis de acesso (`Role`), o recorte por igreja (multi-tenant) e os guards que
fecham as rotas. Tela correspondente no `ic-front`: `docs/login-e-cadastro.md`
e `docs/perfil.md` (troca de senha).

## Login

- **Rota:** `POST /auth/login`, pública. Corpo: `document` (CPF) e `password`.
- **Resposta:** `access_token` (JWT) e o usuário sem o hash da senha.
- **Erros:** `404` documento não cadastrado, `401` senha errada.
- **Pelo Google:** ver "Login com Google" abaixo.
- **Token:** válido por 24h (`JwtModule`, `JWT_SECRET`). O payload traz `sub`
  (id), `username` (nome) e `role`, mas `role` é só uma pista: nenhuma
  autorização é decidida a partir dele — todo guard relê o banco.

Arquivos: `src/auth/auth.controller.ts`, `src/auth/auth.service.ts`,
`src/auth/jwt.strategy/jwt.strategy.ts`, `src/auth/auth.module.ts`.

### Tentativas de login

Toda chamada a `POST /auth/login` grava uma linha em `LoginAttempt` — dando
certo ou não —, com o documento digitado, IP, `User-Agent` (cortado em 255
caracteres) e o motivo da falha (`USER_NOT_FOUND` ou `WRONG_PASSWORD`). A
senha nunca é gravada, nem em claro nem em hash. Se a escrita falhar, o login
segue normalmente: a auditoria não pode derrubar quem digitou a senha certa.

- **Consulta:** `GET /logs/login-attempts`, só perfil `DEV` (ver seção Guards).
- **Descrição do aparelho:** o `User-Agent` de cada tentativa é decodificado
  por `descreverDispositivo` (`src/logs/dispositivo.ts`) em tipo (celular,
  tablet, computador), sistema, navegador e motor de renderização. Campos que
  o navegador esconde de propósito (macOS congelado em "10_15_7", Windows
  sempre "NT 10.0", Android disfarçado como "K") voltam `null` — nada é
  adivinhado.

Arquivos: `src/logs/dispositivo.ts`, `src/logs/logs.controller.ts`,
`src/logs/logs.service.ts`.

## Login com Google

O botão "Entrar com Google" do front (Google Identity Services) entrega um
**ID token**. A API confere o token e emite o **mesmo JWT** do login por CPF e
senha, com o mesmo perfil efetivo (`perfilEfetivo`). O Google só diz quem é a
pessoa: guards, recorte por igreja e sessão continuam iguais.

| Método | Rota | Guard | O que faz |
| --- | --- | --- | --- |
| `POST` | `/auth/google` | pública | entra com `{ credential }` |
| `GET` | `/auth/identities` | `JwtAuthGuard` | contas vinculadas do próprio cadastro (`provider`, `email`, `createdAt`, `lastUsedAt`) |
| `POST` | `/auth/identities/google` | `JwtAuthGuard` | vínculo, passo 1: `{ credential, currentPassword }`; manda o código e devolve o e-mail mascarado |
| `POST` | `/auth/identities/google/confirm` | `JwtAuthGuard` | vínculo, passo 2: `{ code }` (8 dígitos); vincula |
| `DELETE` | `/auth/identities/google` | `JwtAuthGuard` | desvincula |

- **Conferência do token** (`conferirTokenDoGoogle`, `src/auth/google.ts`):
  `google-auth-library` confere a assinatura com as chaves públicas do Google,
  o emissor, a validade e o `aud`, que precisa ser o nosso `GOOGLE_CLIENT_ID`.
  Sem o `aud` certo, um token emitido para outro site entraria aqui. Token
  recusado responde `400`; sem `GOOGLE_CLIENT_ID`, `503` (desligado).
- **Quem identifica a pessoa é o `sub`** do Google, guardado em `UserIdentity`
  (`subject`), e não o e-mail. A pessoa pode trocar o e-mail do cadastro (para
  um Outlook, por exemplo) ou o da conta Google, e o vínculo continua valendo.
  Índices únicos: `provider` + `subject` (uma conta Google, um cadastro) e
  `userId` + `provider` (um Google por cadastro).
- **Primeira entrada (vínculo pelo e-mail):** sem vínculo para o `sub`, a API
  procura o cadastro pelo e-mail e vincula na hora, **só quando o Google
  responde pelo e-mail**: `email_verified` verdadeiro **e** endereço
  `@gmail.com` ou conta do Workspace (`hd`). Num e-mail de fora usado como
  conta Google, `email_verified` diz só que o endereço foi confirmado um dia, e
  ele pode ter mudado de dono depois. Nesses casos a resposta é `404` ("vincule
  pelo perfil").
- **E-mail de mais de um cadastro:** não entra nem vincula (`404`, "este
  e-mail está em mais de um cadastro"). Não há como saber de quem é a conta
  Google; cada pessoa vincula pelo perfil. O e-mail não tem índice único no
  banco por causa de repetidos antigos (ver `docs/usuarios.md`).
- **Cadastro já ligado a outra conta Google:** não troca sozinho, `404`. Trocar
  é pelo perfil: desvincular e vincular a nova.
- **Vínculo pelo perfil, em dois passos.** São duas provas: a senha diz que é
  o dono da conta, e o código diz que é o dono da caixa de entrada (o sistema
  nunca confirmou os e-mails do cadastro).
  1. `POST /auth/identities/google`: confere a senha atual
     (`conferirSenhaAtual`, a mesma trava de 5 erros da troca de e-mail)
     **antes** de olhar o token. Sem isso, quem pegasse uma sessão aberta
     plantaria a própria conta Google como porta de entrada permanente. Depois
     confere o token (`email_verified`; o e-mail pode ser diferente do
     cadastro) e se a conta Google está livre. Grava um `UserToken` tipo 1
     (`TOKEN_TYPE_GOOGLE_LINK`), com o hash bcrypt de um código de 8 dígitos e
     a conta escolhida em `payload` (`subject`, `email`), e manda o código para
     o e-mail do cadastro (template `google-account`, código também no
     assunto). Nada é vinculado ainda.
  2. `POST /auth/identities/google/confirm`: o código confere e a conta do
     `payload` é vinculada; o código vale só para ela e só para o cadastro que
     o pediu. Vence em 15 minutos; 5 erros destroem o pedido; outro pedido
     dentro de 1 minuto responde `429`. Antes de gravar, confere de novo se a
     conta Google continua livre.
- **Desvincular** não pede senha: só fecha uma porta. O CPF e a senha
  continuam valendo.
- **Aviso por e-mail:** todo vínculo e desvínculo manda o template
  `google-account` para o e-mail do cadastro. Falha de e-mail não desfaz nada
  (fica no log).
- **Sem freio de tentativas:** o bloqueio por senha errada é por CPF e não se
  aplica aqui. Não há o que adivinhar: sem um token assinado pelo Google para o
  nosso Client ID, a rota recusa.
- **Tentativas:** gravadas em `LoginAttempt` com `method: GOOGLE` e, em
  `document`, o e-mail da conta Google. Recusa por falta de cadastro vinculado
  usa `reason: USER_NOT_FOUND`.
- **Configuração:** criar um OAuth Client ID do tipo "Aplicativo da Web" no
  Google Cloud Console, com as origens JavaScript autorizadas
  (`https://eventos.iccidadeverde.com` e `http://localhost:5173`). O Client ID
  é público: vai como secret `GOOGLE_CLIENT_ID` no backend e
  `VITE_GOOGLE_CLIENT_ID` no front. Não há client secret nesse fluxo.

Arquivos: `src/auth/google.ts`, `src/auth/google.service.ts`,
`src/auth/dto/google.dto.ts`, `src/auth/google.spec.ts`.

## Validação de sessão

| Método | Rota | Guard | Retorna |
| --- | --- | --- | --- |
| `GET` | `/auth/validate` | `JwtAuthGuard` | perfil, vínculos por igreja, dados básicos |
| `GET` | `/auth/admin/validate` | `JwtAuthGuard` | igual, mas `401` se o perfil não estiver em `ADMIN_AREA_ROLES` |

As duas relêem o usuário no banco (`validateUserGuardRouter`) — não confiam
no payload do token — e devolvem `churchRoles`, que o painel usa para saber em
quais igrejas a pessoa administra.

- **Log:** as duas rotas aparecem no log de requisições como qualquer outra (método, caminho, status e tempo), em `src/common/interceptors/logging.interceptor.ts`. Até 28/09 elas eram silenciadas quando davam certo, o que escondia o tempo delas na investigação de lentidão.
- **Frequência:** o front chama a validação no loader de cada área, antes de mostrar a tela, sempre que o caminho muda (`shouldRevalidate` em `src/routes/index.tsx` do `ic-front`). Detalhes no `ic-front`, em `docs/login-e-cadastro.md`.

## Esqueci a senha / redefinição

Fluxo em três etapas, todo público (quem esqueceu a senha não tem token). O
front chama `POST /auth/password/forgot` → `verify-code` → `reset`.

| Etapa | Rota | O que faz |
| --- | --- | --- |
| 1 | `POST /auth/password/forgot` | Recebe o CPF, gera código de 8 dígitos e envia por e-mail |
| 2 | `POST /auth/password/verify-code` | Confere o código e devolve um `ticket` de uso único |
| 3 | `POST /auth/password/reset` | Grava a senha nova com o `ticket` e apaga o processo |

- **Resposta genérica:** a etapa 1 sempre responde a mesma mensagem, exista ou
  não cadastro para o CPF — evita virar consulta de quem está cadastrado.
- **Cooldown:** 60s entre dois pedidos de código para o mesmo CPF.
- **Código:** 8 dígitos, válido por 60 minutos, até 5 tentativas erradas —
  na 6ª o token é destruído e é preciso recomeçar pelo CPF.
- **Ticket:** 256 bits de entropia (hex), válido por 15 minutos, uso único.
  Ticket inválido/expirado responde `401` (não `400`): o front trata como
  sessão morta e reinicia o fluxo pelo CPF.
- **Aviso por e-mail:** ao concluir a troca, um e-mail avisa que a senha
  mudou — é como o dono percebe se não foi ele quem trocou.
- **Senha:** 8 a 72 caracteres (limite do bcrypt), sem exigência de
  maiúscula/símbolo (segue NIST SP 800-63B).

Arquivos: `src/auth/password-reset/password-reset.controller.ts`,
`src/auth/password-reset/password-reset.service.ts`,
`src/auth/password-reset/dto/password-reset.dto.ts`.

## Troca de senha com a senha atual

- **Rota:** `POST /auth/password/change`, autenticado. Corpo:
  `currentPassword` e `password` (nova).
- **Por quê:** a sessão sozinha não prova que é o dono (navegador esquecido
  aberto). A senha atual é conferida antes de gravar a nova.
- **Bloqueio por tentativas (`conferirSenhaAtual`, `src/auth/senha.ts`):** 5
  erros de senha atual travam a conferência por 15 minutos, por usuário.
  Responde `400` (não `401` — no front, 401 derruba o login). A contagem é em
  memória do processo (`ponytail`: zera em restart, não é compartilhada entre
  réplicas — migrar para banco/Redis se a API rodar com mais de uma
  instância).
- Mesma trava usada em `UserService.updateMe` ao trocar o e-mail (exige a
  senha atual).
- A nova senha precisa ser diferente da atual, senão `400`.
- Troca de senha apaga qualquer código de redefinição pendente na mesma
  transação (evita duas portas abertas ao mesmo tempo).

Arquivo: `src/auth/senha.ts`.

## Papéis (`Role`)

`src/auth/roles.ts`. Valor gravado em `User.role` (`Int`).

| Papel | Valor | Alcance |
| --- | --- | --- |
| `DEV` | -1 | poder de super admin, com rótulo próprio; único que pode ver logs e conceder o perfil Dev |
| `SUPER_ADMIN` | 1 | atravessa todas as igrejas |
| `ADMIN` | 2 | perfil de painel, por igreja (`UserChurchRole`) |
| `FINANCE` | 3 | perfil de painel, por igreja; só inscritos e pagamentos |
| `USER` | 5 | usuário comum, não pertence a nenhuma igreja |

- `ADMIN_ROLES` = Dev + Super Admin + Admin (acesso total ao painel).
- `ADMIN_AREA_ROLES` = `ADMIN_ROLES` + Financeiro (entra no painel, com abas
  restritas no front).
- `role` é **derivado**: sempre igual ao mais alto perfil entre os vínculos
  que valem (`perfilEfetivo`, `src/auth/tenant.ts`). É recalculado na mesma
  transação que grava `UserChurchRole`, e também quando a igreja é salva
  (`ChurchService.recalcularPerfis`). Dev e Super Admin são globais e não
  derivam de vínculo.
- **Vínculo com igreja inativa não vale:** `SELECT_TENANT` só traz os de igreja
  não `INACTIVE` (`VINCULO_VALE`). Como todo guard e service lê por ele, quem
  só administrava uma igreja desativada vira usuário comum. O login e o
  `/auth/validate` também descartam esses vínculos.
- **Quem decide o acesso é o perfil efetivo, não o gravado.** O login (é por
  ele que o front decide abrir o painel), o `/auth/validate`, o
  `/auth/admin/validate` e o `RolesGuard` calculam `perfilEfetivo` a partir
  dos vínculos que valem. O `User.role` gravado pode estar atrasado: igreja
  desativada antes de 06/10/2026, quando o recálculo ainda não existia. Com o
  cálculo na leitura, o valor atrasado não abre nada. Ele só aparece como
  rótulo na lista de usuários, e se corrige quando a igreja é salva de novo. A tela de permissões
  (`GET /users/:id`) mostra todos, com a situação da igreja. Ver
  `docs/igrejas.md`.

## Recorte por igreja (`src/auth/tenant.ts`)

Multi-tenant: quem administra mora em `UserChurchRole` (uma linha por
igreja). A mesma pessoa pode ser admin de uma igreja e financeiro de outra.

- **`isSuperAdmin`:** super admin ou dev — atravessa todas as igrejas.
- **`tenantChurchIds`:** igrejas que o requisitante alcança. `null` = sem
  recorte (super admin, ou usuário comum vendo o catálogo aberto). Lista
  vazia = nenhuma igreja (perfil de painel sem vínculo nenhum) — fecha por
  padrão.
- **`assertChurchAccess`:** barra o acesso a um recurso de igreja que a
  pessoa não alcança (`403`). Usado quando a operação é sobre um recurso
  específico, não para filtrar uma lista.
- **`userChurchScope`:** filtro Prisma para listar pessoas: entra quem
  administra a igreja ou participa (inscrito/lista de espera) de evento dela.

## Guards

| Guard | Arquivo | O que confere |
| --- | --- | --- |
| `JwtAuthGuard` | `src/decorators/auth.guard.ts` | token válido (estratégia `jwt`) |
| `RolesGuard` | `src/decorators/roles.guard.ts` | perfil (`User.role`, lido do banco) está entre os `@Roles(...)` da rota |
| `EventTenantGuard` | `src/decorators/event-tenant.guard.ts` | perfil de igreja **na igreja do evento** da rota (`:idEvent`/`:eventId`, ou o evento do `:paymentId`) |
| `ChurchTenantGuard` | `src/decorators/church-tenant.guard.ts` | perfil de igreja **na igreja do caminho** (`:churchId`/`:idChurch`) |

- `RolesGuard` só responde "a pessoa chega nesta rota em alguma igreja?". Não
  decide qual igreja — isso é `EventTenantGuard`/`ChurchTenantGuard`.
- Os dois guards de tenant leem o vínculo do banco, nunca do JWT: o token
  dura 24h e manteria uma permissão já revogada.
- `EventTenantGuard`: rota sem `@Roles` (ex.: inscrever-se) e `:idUser` igual
  ao próprio token passa direto — é área do usuário, não do painel.
- Uso típico: `@UseGuards(JwtAuthGuard, RolesGuard, EventTenantGuard)` +
  `@Roles(...ADMIN_ROLES)` (ou `ChurchTenantGuard` para rotas de
  `/churches/:churchId/...`, como a configuração de gateway de pagamento).

## Quem acessa o quê (resumo)

| Rota | Quem entra |
| --- | --- |
| `POST /auth/login`, `POST /auth/password/forgot\|verify-code\|reset` | público |
| `GET /auth/validate`, `POST /auth/password/change` | qualquer autenticado |
| `GET /auth/admin/validate` | `ADMIN_AREA_ROLES` |
| `GET /logs`, `/logs/operations`, `/logs/:id` | dev e super admin |
| `GET /logs/login-attempts` | só `DEV` |
| Rotas sob `/events/:idEvent/...` de painel | perfil de igreja exigido, na igreja daquele evento |
| Rotas sob `/churches/:churchId/...` de painel | perfil de igreja exigido, naquela igreja |
