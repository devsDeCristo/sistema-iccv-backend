# Autenticação

Módulo de login, sessão e recuperação de senha do sistema. Cobre também os
perfis de acesso (`Role`), o recorte por igreja (multi-tenant) e os guards que
fecham as rotas. Tela correspondente no `ic-front`: `docs/login-e-cadastro.md`
e `docs/perfil.md` (troca de senha).

## Login

- **Rota:** `POST /auth/login`, pública. Corpo: `document` (CPF) e `password`.
- **Resposta:** `access_token` (JWT) e o usuário sem o hash da senha.
- **Erros:** `404` documento não cadastrado, `401` senha errada.
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

## Validação de sessão

| Método | Rota | Guard | Retorna |
| --- | --- | --- | --- |
| `GET` | `/auth/validate` | `JwtAuthGuard` | perfil, vínculos por igreja, dados básicos |
| `GET` | `/auth/admin/validate` | `JwtAuthGuard` | igual, mas `401` se o perfil não estiver em `ADMIN_AREA_ROLES` |

As duas relêem o usuário no banco (`validateUserGuardRouter`) — não confiam
no payload do token — e devolvem `churchRoles`, que o painel usa para saber em
quais igrejas a pessoa administra.

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
- `role` é **derivado**: sempre igual ao mais alto perfil entre os vínculos da
  pessoa (`UserService.perfilEfetivo`), recalculado na mesma transação que
  grava `UserChurchRole`. Dev e Super Admin são globais e não derivam de
  vínculo.

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
| `GET /logs`, `/logs/operations`, `/logs/login-attempts`, `/logs/:id` | só `DEV` |
| Rotas sob `/events/:idEvent/...` de painel | perfil de igreja exigido, na igreja daquele evento |
| Rotas sob `/churches/:churchId/...` de painel | perfil de igreja exigido, naquela igreja |
