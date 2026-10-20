# Eventos

O módulo de eventos é o CRUD central do sistema: cadastro do evento (nome,
datas, cores, módulos, termo), seus grupos de inscrição e a loja de produtos.
Ele decide também quem enxerga cada evento — catálogo público, painel do
admin ou ensaio de configuração.

Arquivos: `src/event/event.controller.ts`, `src/event/event.service.ts`,
`src/event/dto/event.dto.ts`, `src/event/event-visibility.ts`,
`src/event/event-modules.ts`, `src/event/event-quadrante.ts`,
`src/event/event-terms.ts`.

## Status do evento (`EventStatus`)

| Status | Efeito |
| --- | --- |
| `ACTIVE` | Aberto ao público: aparece na área do usuário para qualquer inscrito. Padrão ao criar. |
| `INACTIVE` | Desligado: some da área do usuário para todo mundo. A loja de produtos do evento também fecha — comprar devolve `400` ("A loja deste evento está fechada"), mesmo com `data.publicStore` ligado. |
| `TEST` | Ensaio de configuração: só quem administra a igreja do evento (ou super admin) enxerga. Para os demais o evento simplesmente não existe (`404`). |

**Igreja em teste** (`ChurchStatus.TEST`, implantação) vale como ensaio para todos os eventos dela, inclusive os `ACTIVE`: só quem administra aquela igreja (ou super admin) vê na lista e abre o evento; para os demais ele some do catálogo e o detalhe responde `404`. A regra mora em `src/event/event-visibility.ts` (`filtroDeEventoEmTeste` na lista, `assertEventIsVisible` no detalhe). Antes só o filtro de igrejas da home escondia a igreja em teste, e os eventos dela seguiam aparecendo em "Todas".

O campo antigo `Event.isActive` continua no banco mas está `@ignore` no
Prisma: nada lê ou escreve nele hoje, quem manda é `status`.

Arquivo: `prisma/schema.prisma` (enum `EventStatus`).

### Igreja no detalhe do evento

`GET /events/:id` traz da igreja `modulePayment` (o módulo Eventos do plano da igreja, que inclui a cobrança online — ver `docs/planos.md`), `name` (o cabeçalho das
planilhas exportadas da página do evento) e `chargesOnline` (módulo ligado e
gateway ativo, calculado por `igrejaCobraOnline`; o painel mostra "Conferir no
gateway" só com ele ligado).

### Contagens da lista do painel

A lista de eventos do painel devolve, por evento, `users`, `capacity` (soma das
vagas dos grupos), `waitlist`, `bedroom`, `team` e `transport` (contagem de
transportes, para a coluna Módulos), além do `data` com os módulos ligados.
Arquivo: `src/event/event.service.ts` (`handlerReturnAllEvents`).

### Status em massa (`PUT /events/status`)

O mesmo status para vários eventos de uma vez — a barra de seleção da lista de
eventos do painel.

- **Corpo:** `{ eventIds, status }`, até 200 eventos (`MAXIMO_DE_EVENTOS_EM_MASSA`).
- **Rota:** `@Roles(ADMIN_ROLES)`. Fica antes de `PUT :idEvent` no controller,
  senão o Nest casaria "status" como um id. Sem id na URL o `EventTenantGuard`
  deixa passar, e quem confere a igreja de cada evento é o serviço.
- **Por evento:** só admin da igreja dele, ou super admin (`assertChurchAccess`
  com `Role.ADMIN`, a mesma régua da edição). Tesouraria não muda status.
  Evento de igreja sem Eventos no plano volta em `falhas` ("O plano da igreja
  não inclui o módulo Eventos"); super admin e dev passam.
- **Gravação:** um `updateMany` só, com os que passaram. Trocar o status é só
  gravar o campo; a edição completa não faz nada além disso com ele.
- **Resposta:** `{ atualizados, falhas: [{ eventId, nome, motivo }] }`. Evento
  de outra igreja ou id que não existe volta em `falhas`, sem impedir os outros.

Arquivos: `src/event/event.service.ts` (`atualizarStatusEmMassa`),
`src/event/dto/status-em-massa.dto.ts`, `src/event/status-em-massa.spec.ts`.

## Equipe do evento: admins e tesoureiros(as)

Quem cuida de um evento sem ser admin da igreja. **Pode ser qualquer usuário do sistema**, membro da igreja ou não. Nenhum dos dois é perfil: não muda `User.role` nem `perfilEfetivo`, e quem só tem esses vínculos continua usuário comum fora do painel.

- **Onde se define:** no cadastro e na edição do evento (`POST /events` e `PUT /events/:idEvent`), pelos campos `adminIds: string[]` e `tesoureiros: { userId, kind }[]` (no multipart, JSON em texto). Omitido, nada muda; enviado, **vira a lista** (quem saiu perde o vínculo). Os tesoureiros também se alocam pela Tesouraria (`events/:idEvent/tesoureiros`, ver `docs/tesouraria.md`). Membros **não** mexe aqui: lá é só o perfil na igreja.
- **Quem define:** o admin da igreja do evento (e dev/super admin). O admin de evento edita o resto do evento, mas mandar `adminIds`/`tesoureiros` volta 403 — senão ele se daria tesoureiro(a) completo e chegaria à Tesouraria.
- **Qualquer perfil entra** — super admin, admin ou tesouraria da igreja também: o vínculo só soma, e vale o maior perfil. **A recusa (400) nunca conta o perfil de ninguém:** só quem não existe e a mesma pessoa duas vezes na lista. Até 13/10/2026 recusava por perfil com o nome e o perfil da pessoa na mensagem ("Fulana é super admin…") — um vazamento do perfil de terceiros. Tudo é conferido antes de qualquer escrita (`validarEquipe`); na edição a gravação é numa transação interativa à parte (`gravarEquipe`), porque `deleteMany` + escrita na forma em array perde as escritas no middleware de auditoria.
- **E-mail:** quem ganha o papel (ou troca de tipo de tesoureiro) recebe um aviso depois de gravar, sem a tela esperar por ele — ver "Acesso ao evento" em `docs/email.md`.
- **No detalhe:** `GET /events/:id?painel=true` devolve `admins: [{ user }]` e `treasurers: [{ kind, user }]` (id, nome, e-mail, foto), para o formulário vir preenchido. O catálogo não traz.

### Admin de evento (`EventAdmin`)

- **Modelo:** tabela `event_admins`, chave `(eventId, userId)`, `createdById`. Apagar o evento ou a pessoa apaga o vínculo; vínculo de igreja desativada não vale. Migration `20261013120000_admins_de_evento` (só cria a tabela). No log: "Admin do evento".
- **O que faz:** dentro do evento, vale como o admin da igreja — editar, inscritos (inclusive inscrever quem está no cadastro da igreja do evento), lista de espera, equipes, quartos, transporte, crachás, check-in, quadrante e **os pagamentos** (conferir, dar baixa, estornar, entrega de produtos). **Não** apaga o evento (rota só de dev), não cria eventos, não muda status em massa, não define a equipe do evento e **não vê a Tesouraria** (o módulo).
- **Fora do evento:** a lista de Membros da igreja do evento (sem os pedidos) e o cadastro das pessoas que a igreja alcança — ver e **editar o perfil**, com os dados sensíveis. Não troca e-mail nem CPF (com o e-mail trocado, o "esqueci a senha" daria a conta a ele) e não edita quem tem perfil de painel (`docs/usuarios.md`). Vê os pagamentos de uma pessoa só nos eventos das igrejas dele.
- **Como a rota o aceita** (`src/auth/admin-do-evento.ts`): `@AceitaAdminDoEvento()` na classe dos controllers do evento (eventos, pagamentos, quartos, equipes, transporte, crachás, check-in) no `GET churches/:churchId/membros` e no `GET /users` (recortado no service, ver `docs/usuarios.md`). Nas rotas do evento sem `@Roles` (inscrever outra pessoa, ver os pagamentos de um inscrito) o `EventTenantGuard` também aceita o admin deste evento, para quem tem perfil em outra igreja. Vale **só em rota cujo `@Roles` aceita admin** — rota só de dev continua fechada mesmo marcada. O `RolesGuard` deixa passar quem tem algum vínculo; o `EventTenantGuard` cobra que seja **deste** evento (rota sem evento, como criar evento, recusa); o `ChurchTenantGuard`, que seja de um evento **desta** igreja. O controller dos tesoureiros fica sem a marca de propósito.
- **No painel:** `GET /events?painel=true` traz os eventos dele (ensaio inclusive), e `GET /events/:id?painel=true` abre o evento dele.
- **Sessão:** `login`, `/auth/validate` e `/auth/admin/validate` mandam `eventAdmins` (`eventId`, `eventName`, `churchId`, `churchName`, `modulos`). O painel admite quem tem perfil de painel **ou** vínculo de tesoureiro **ou** de admin de evento.
- **Testes:** `event-tenant.guard.spec.ts`, `roles.guard.spec.ts`, `inscricao-de-terceiros.spec.ts`, `quadrante-acesso.spec.ts`, `event-equipe.spec.ts`.

## Visibilidade

- **Catálogo (área do usuário):** todo evento `ACTIVE`/`INACTIVE` aparece,
  de qualquer igreja — inclusive para quem administra. Evento `TEST` só
  aparece para quem administra aquela igreja específica.
- **Painel administrativo:** a lista já vem recortada pelas igrejas de quem
  pediu (`emPainel=true`); a regra de `TEST` se aplica em cima disso.
- **`filtroDeEventoEmTeste`** (filtro de listagem) e **`podeVerEventoEmTeste`**
  (caso a caso, em `findOne`/`assertEventIsVisible`) olham a igreja do evento,
  não o perfil efetivo do usuário: quem é admin numa igreja e tesouraria em
  outra não vê o ensaio da igreja onde só cuida da tesouraria. Super admin
  atravessa todas. Fora do alcance, o evento `TEST` devolve `404` como se não
  existisse.

Arquivos: `src/event/event-visibility.ts`, `src/event/event-visibility.spec.ts`.

## Campos de `data` (JSON livre do evento)

`Event.data` é um JSON sem coluna própria, para não exigir migração a cada
configuração nova. Campos conhecidos:

| Campo | Tipo | Uso |
| --- | --- | --- |
| `modules` | `{ bedrooms, teams, transport: boolean }` | liga/desliga as abas de Quartos, Equipes e Transporte. Ausente equivale a **ligado** (eventos antigos não têm a chave). |
| `showQuadrante` | `boolean` | mostra o quadrante de equipes (e-mail, celular, nascimento). Ausente equivale a **desligado** — dado sensível não se abre por acidente. Só vale com `modules.teams` ligado. |
| `publicStore` | `boolean` | quem compra na loja de produtos: `true` libera qualquer cadastrado; ausente/`false` restringe a quem já tem inscrição confirmada no evento. |
| `colors` | objeto livre | paleta de cores do evento (tela do front). |
| `registrationTerm` | `string` (HTML) | termo de inscrição exigido na hora de se inscrever. Vazio de verdade (inclusive `<p><br></p>` do editor) conta como "sem termo" — ver `termoDeInscricao`/`exigeAceiteDeTermo`. |
| `coverUrl`, `logoUrl`, `logoUrlInverted` | `string` (URL Firebase) | gravados pelo serviço depois do upload, não vêm do corpo. |
| `minorTermUrl` | `string` (data URI base64) | termo de autorização para menores, salvo direto no banco. |
| `minorAgeLimit` | `16 \| 18` | até que idade (no primeiro dia do evento) o termo de autorização é exigido. Normalizado por `idadeDoTermo`: só `18` vale 18, o resto é 16. Ausente na edição mantém o atual; mudar com inscritos reclassifica — ver `docs/inscricoes.md`. |
| `logoBase64`, `coverBase64` | `string` (data URI) | só aparecem na resposta quando `embedImages=true` é pedido; nunca gravados. |

Na edição (`update`), `data` é gravado por inteiro — o que não vem no corpo
some. Para não apagar configuração por omissão, o serviço preserva
explicitamente `modules`, `colors`, `showQuadrante`, `publicStore` e `minorAgeLimit` quando
ausentes no corpo (herdam o valor atual do evento). Os demais campos de
`data` seguem a regra geral: ausente é apagado.

Arquivos: `src/event/event.service.ts` (bloco de `update`, em torno da
gravação de `safeData`), `src/event/dto/event.dto.ts`.

## Módulos do evento

Mora em `data.modules`, com três chaves conhecidas: `bedrooms`, `teams`,
`transport`. Controla se a aba correspondente aparece no painel.

- **`modulosDoEvento`/`moduloAtivo`:** leem o estado atual; ausência vale
  ligado.
- **`normalizarModulos`:** reduz o que veio do corpo às três chaves
  conhecidas e a booleano — um valor não-booleano (ex.: string) não liga
  módulo por engano.
- **`modulosDesligados`:** compara antes/depois e devolve só os módulos que
  estavam ligados e passaram a desligado nesta edição.
- **Trava ao desligar:** `assertModulosPodemDesligar` impede desligar um
  módulo que já tem cadastro (quartos, equipes ou transporte existentes) —
  devolve `400` pedindo para apagar os registros antes.

Arquivos: `src/event/event-modules.ts`, `src/event/event-modules.spec.ts`.

## Certificado de participação

Também vem no cadastro e na edição do evento: o campo `certificate` do
multipart (JSON em texto — `{ enabled, workload, signers }`), gravado em
`event_certificates` na mesma transação. Omitido, nada muda. Fica fora de
`data`, que é público, porque leva a imagem da assinatura de gente. Regras,
geração e verificação em `docs/certificados.md`.

## Quadrante de equipes

`showQuadrante` (em `data`) libera a lista de e-mail, celular e data de
nascimento da equipe. Ao contrário dos módulos, **ausente é desligado** —
dado sensível exige decisão explícita de quem organiza. Mesmo ligado, sem o
módulo `teams` o quadrante não existe (não há equipe para mostrar).

Arquivo: `src/event/event-quadrante.ts`.

## Imagens (capa e logo)

- **Upload:** capa e logo chegam como arquivo multipart (`coverFile`,
  `logoFile`) na criação e edição, e sobem ao Firebase Storage
  (`uploadImgFirebase`) em `events/{eventId}/cover/...` e
  `events/{eventId}/logo/...`. As URLs voltam para `data.coverUrl` e
  `data.logoUrl`. Na edição, trocar a logo também gera uma versão preta
  sobre fundo transparente (`sharp`) em `data.logoUrlInverted`.
- **Termo de menor:** o arquivo (`termFile`) não sobe ao Storage — fica
  salvo como data URI base64 direto em `data.minorTermUrl`.
- **Cache de imagem embutida (PDF):** `findOne` aceita `?embedImages=true`,
  usado só pela geração de crachá/PDF (custa ~1,5s por imagem em cache frio,
  porque o `?alt=media` do Firebase Storage tem TTFB alto mesmo para
  arquivos pequenos). `getLogoImgFromUrl` baixa a imagem, valida
  host/tipo/tamanho e guarda o resultado num cache em memória (`imageCache`,
  até 50 entradas, TTL de 24h; erro de download cacheia por só 30s). A chave
  muda a cada edição do evento (`updateAt`), invalidando o cache sozinha ao
  trocar logo/capa. `buildEmbeddedImages` baixa logo e capa em paralelo e
  popula `data.logoBase64`/`data.coverBase64` na resposta.

Arquivos: `src/event/event.service.ts` (funções `getLogoImgFromUrl`,
`buildEmbeddedImages`, `imageCacheKey`, `setCachedImage`/`getCachedImage`),
`src/utils/uploadImgFirebase.ts`.

## Grupos e regras de inscrição

Grupos (`GroupRoles`) e suas regras de valor (`RolesRegistration`) são
editados junto do evento, no `create`/`update` (array `groupRoles` do DTO).
A janela de abertura/fechamento de cada grupo (`active`, `opensAt`,
`closesAt`) já está documentada em `docs/inscricao-em-grupos.md` — não é
repetida aqui.

## Exclusão do evento

| Quem pode | Bloqueios |
| --- | --- |
| Só perfil `DEV` (`@Roles(Role.DEV)`), e só administrando a igreja do evento | Evento com pelo menos 1 inscrito não pode ser apagado (`400`, mensagem com a contagem). Evento com compra na loja paga ou aguardando pagamento também não pode (`400`, mensagem com a contagem). |

A checagem de perfil é feita de novo dentro do serviço, lendo o banco (não
o token) — um usuário rebaixado de `DEV` não apaga nada mesmo com token
antigo ainda válido. Passando pelas travas, a exclusão roda numa transação
que remove em cascata: pagamentos e checkouts, quartos/equipes/transporte e
seus vínculos, lista de espera, check-ins, inscrições e por fim grupos,
regras e o próprio evento.

Arquivo: `src/event/event.service.ts` (método `remove`), rota
`DELETE /events/:idEvent` em `src/event/event.controller.ts`.

## Rotas principais

| Método | Caminho | Quem pode | Observação |
| --- | --- | --- | --- |
| `POST` | `/events` | `ADMIN_ROLES` (admin, super admin, dev) | Cria evento; igreja vem do vínculo de quem cria (super admin escolhe via `churchId`). |
| `GET` | `/events` | Qualquer autenticado | `?painel=true` traz a lista recortada pelas igrejas administradas por quem pediu; sem o parâmetro é o catálogo completo (todas as igrejas), igual para admin e inscrito. |
| `GET` | `/events/insights` | `ADMIN_AREA_ROLES` (+ tesouraria) | Números agregados, recortados pelas igrejas de quem pediu. |
| `GET` | `/events/:id` | Qualquer autenticado | `?painel=true` restringe às igrejas administradas (fora disso, `404`); `?embedImages=true` inclui `logoBase64`/`coverBase64`, só para geração de PDF. |
| `PUT` | `/events/:idEvent` | `ADMIN_ROLES` | Edita evento, grupos, produtos e imagens; só admin da igreja do evento (ou super admin, que também pode mover o evento de igreja). |
| `DELETE` | `/events/:idEvent` | `Role.DEV` | Ver seção "Exclusão do evento". |

Todas as rotas passam por `EventTenantGuard`, que resolve a igreja do
evento pela URL antes da checagem de perfil.

## Catálogo x painel (tenant)

- **Catálogo:** sem `painel=true`, qualquer autenticado navega por todos os
  eventos `ACTIVE`/`INACTIVE` de todas as igrejas — o admin, aqui, é
  tratado como um inscrito comum.
- **Painel:** com `painel=true`, a lista (e a abertura de um evento
  específico) é recortada por `tenantChurchIds`, que devolve as igrejas
  onde o requisitante tem perfil em `ADMIN_AREA_ROLES` (admin, super admin,
  dev, tesouraria). Super admin recebe `null` do `tenantChurchIds` e por
  isso não é filtrado — vê tudo.
- Abrir um evento pelo painel que não é de nenhuma igreja administrada
  devolve `404`, mesmo que o evento exista.

Arquivos: `src/event/event.service.ts` (`findAll`, `findOne`),
`src/auth/tenant.ts` (`isSuperAdmin`, `tenantChurchIds`,
`churchIdsComPerfil`).

## Tela correspondente

ic-front, `docs/admin-eventos.md`.
