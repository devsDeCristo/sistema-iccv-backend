# Planos (módulos por igreja)

O plano de uma igreja diz quais módulos ela usa. Fora do plano, o módulo some do painel daquela igreja e a API dele recusa; **nada é apagado** — voltar o módulo ao plano devolve tudo.

**O plano recorta quem trabalha na igreja** (admin, financeiro). **Dev e super admin veem todos os módulos de todas as igrejas**: o plano não vale para eles.

Código: `src/planos` (`PlanosController`, `PlanosService`, `ModuloGuard`, `modulos.ts`).

## Modelo

- `Plan { id, name (único), description?, modules ChurchModule[] }`, tabela `plans`.
- `Church.planId` (opcional, `onDelete: Restrict`): o plano da igreja.
- **Igreja sem plano não tem módulo nenhum**: só o painel básico (Início, Usuários e Membros). Nenhuma igreja nasce com plano — nem as que já existiam: depois da migração, o super admin escolhe um plano para cada uma em Igrejas.
- Os limites que vierem (quantidade de eventos e etc.) entram no `Plan` como colunas próprias.

### Módulos (`ChurchModule`)

**Membros não é módulo:** toda igreja tem, com ou sem plano (e o financeiro depende dele — os dizimistas são os membros).

| Módulo | O que fecha |
| --- | --- |
| `EVENTS` | Painel de eventos: criar, editar, inscritos, equipes, quartos, transporte, crachás, quadrante, check-in e os pagamentos do evento no painel |
| `NEWS` | Notícias e disparos |
| `TREASURY` | Tesouraria (`/churches/:churchId/financeiro`) |
| `WHATSAPP` | O WhatsApp da igreja (`/churches/:churchId/whatsapp`) |
| `INTEGRATIONS` | Pluggy (`/churches/:churchId/pluggy`) |
| `ONLINE_PAYMENTS` | Cobrança online nos eventos (o antigo `Church.modulePayment`) |

## Rotas (`/plans`)

Só **dev e super admin** (`SUPER_ADMIN_ROLES`), como a gestão de igrejas.

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/plans` | Lista, com `_count.churches` |
| `POST` | `/plans` | `{ name, description?, modules[] }` |
| `PUT` | `/plans/:id` | Atualiza; os módulos novos valem na hora para as igrejas do plano |
| `DELETE` | `/plans/:id` | Só plano que nenhuma igreja usa (409 com quantas usam) |

Nome repetido (sem diferenciar maiúsculas) responde 409. O plano da igreja se escolhe em `POST/PUT /churches` (`planId`; `null` tira o plano; omitido na edição mantém) — ver `docs/igrejas.md`.

## Como o módulo é cobrado

- **`@Modulo(ChurchModule.X)` + `ModuloGuard`** nos controllers do módulo, no fim do `@UseGuards` (depois do login e do recorte por igreja). Não é global de propósito: rodaria antes do login, e um anônimo leria na recusa o nome da igreja.
- **Recusa:** 403 "O plano de <igreja> não inclui o módulo <módulo>". **Dev e super admin passam** (o perfil lido do banco pelo `RolesGuard`, que roda antes).
- **Só o painel:** rota sem `@Roles` é área do usuário (ver evento, inscrever-se, pagar a própria inscrição) e passa. O evento já publicado segue aberto ao público com Eventos fora do plano.
- **Cobrança online** não é acesso de ninguém: é se a igreja cobra. Sem o módulo ela não cobra, quem quer que abra o checkout.
- **A igreja sai da rota:** `:churchId`; o evento (`:idEvent`, `:eventId`, ou `:id` nas rotas de Eventos); o pagamento (`:paymentId` → evento); a notícia (`:id` nas rotas de Notícias); ou o `churchId` do corpo. Sem nada disso (listas de várias igrejas, criação sem igreja escolhida), passa.
- **Criação:** criar evento e criar notícia (e trocar a notícia de igreja) conferem no service, depois de saber a igreja — quem administra uma igreja só nem manda o `churchId`. Dev e super admin passam aqui também.
- **Limite conhecido:** listas que juntam várias igrejas (`GET /events`, `GET /news/admin` sem igreja escolhida, insights) não filtram pelo plano; a tela esconde o módulo, e qualquer ação sobre um item volta 403.

## Cobrança online (`ONLINE_PAYMENTS`)

Substituiu `Church.modulePayment` (a coluna saiu na migração; a rota `PATCH /churches/:churchId/payment-providers/module` também). Quem lia o campo agora usa `cobraOnline(igreja)` / `SELECT_MODULOS` / `SEM_COBRANCA_ONLINE` (`src/planos/modulos.ts`): checkout (503 sem o módulo), reconciliação e cron (pulam a igreja), `igrejaCobraOnline`. Para não mudar a tela, as respostas seguem com o nome `modulePayment` (evento, minhas inscrições, configuração de gateways) — agora calculado pelo plano.

## Sessão

`/auth/validate` e `/auth/admin/validate` devolvem em cada vínculo `church.modulos` (os módulos do plano da igreja). A tela renova a sessão a cada navegação no painel: trocar o plano vale na navegação seguinte de quem já está logado.

## Migration

`20261012120000_planos`: cria o enum `ChurchModule`, a tabela `plans` e `churches.planId` (nula), e **apaga `churches.modulePayment`**. Depois de aplicar, nenhuma igreja tem módulo nenhum — nem cobrança online — até o super admin criar os planos e escolher um para cada igreja. Testada aplicando todas as migrations num Postgres vazio (planos, plano em uso não apaga, `SEM_COBRANCA_ONLINE`, recusa da igreja sem plano).

## Auditoria

`Plan` passa pelo log como "Plano" e é tabela principal.
