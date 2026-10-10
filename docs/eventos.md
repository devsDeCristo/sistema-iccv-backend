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

O campo antigo `Event.isActive` continua no banco mas está `@ignore` no
Prisma: nada lê ou escreve nele hoje, quem manda é `status`.

Arquivo: `prisma/schema.prisma` (enum `EventStatus`).

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
  com `Role.ADMIN`, a mesma régua da edição). Financeiro não muda status.
- **Gravação:** um `updateMany` só, com os que passaram. Trocar o status é só
  gravar o campo; a edição completa não faz nada além disso com ele.
- **Resposta:** `{ atualizados, falhas: [{ eventId, nome, motivo }] }`. Evento
  de outra igreja ou id que não existe volta em `falhas`, sem impedir os outros.

Arquivos: `src/event/event.service.ts` (`atualizarStatusEmMassa`),
`src/event/dto/status-em-massa.dto.ts`, `src/event/status-em-massa.spec.ts`.

## Visibilidade

- **Catálogo (área do usuário):** todo evento `ACTIVE`/`INACTIVE` aparece,
  de qualquer igreja — inclusive para quem administra. Evento `TEST` só
  aparece para quem administra aquela igreja específica.
- **Painel administrativo:** a lista já vem recortada pelas igrejas de quem
  pediu (`emPainel=true`); a regra de `TEST` se aplica em cima disso.
- **`filtroDeEventoEmTeste`** (filtro de listagem) e **`podeVerEventoEmTeste`**
  (caso a caso, em `findOne`/`assertEventIsVisible`) olham a igreja do evento,
  não o perfil efetivo do usuário: quem é admin numa igreja e financeiro em
  outra não vê o ensaio da igreja onde só cuida do financeiro. Super admin
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
| `logoBase64`, `coverBase64` | `string` (data URI) | só aparecem na resposta quando `embedImages=true` é pedido; nunca gravados. |

Na edição (`update`), `data` é gravado por inteiro — o que não vem no corpo
some. Para não apagar configuração por omissão, o serviço preserva
explicitamente `modules`, `colors`, `showQuadrante` e `publicStore` quando
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
| `GET` | `/events/insights` | `ADMIN_AREA_ROLES` (+ financeiro) | Números agregados, recortados pelas igrejas de quem pediu. |
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
  dev, financeiro). Super admin recebe `null` do `tenantChurchIds` e por
  isso não é filtrado — vê tudo.
- Abrir um evento pelo painel que não é de nenhuma igreja administrada
  devolve `404`, mesmo que o evento exista.

Arquivos: `src/event/event.service.ts` (`findAll`, `findOne`),
`src/auth/tenant.ts` (`isSuperAdmin`, `tenantChurchIds`,
`churchIdsComPerfil`).

## Tela correspondente

ic-front, `docs/admin-eventos.md`.
