# Quartos, equipes e transporte

Três módulos opcionais do evento que resolvem o mesmo problema — encaixar pessoas em lugares com capacidade limitada — cada um numa área diferente: hospedagem (`bedrooms`), equipes de serviço (`team`) e veículos (`transport`). `TransportService` é descrito no próprio código como "o gêmeo" de `BedroomsService`: mesma capacidade, mesmas tags, mesma restrição por grupo de inscrição.

Arquivos: `src/bedrooms/*`, `src/team/*`, `src/transport/*`.

## Módulos do evento

Cada um dos três só aceita cadastro se o respectivo módulo estiver ligado no evento (`Event.data.modules`, `src/event/event-modules.ts`):

- **Ligado por padrão:** ausência da chave em `Event.data.modules` conta como **ligado**. Eventos antigos, criados antes de a chave existir, não perdem os quartos e equipes já cadastrados quando o código sobe.
- **Checagem em toda escrita:** `create` (quartos, equipes, transporte) recusa com `400` "O módulo [Quartos/Equipes/Transporte] está desligado neste evento" se o módulo estiver desligado — mesmo que a tela já esconda a aba, a rota continua existindo e um formulário aberto antes de desligar o módulo ainda tentaria gravar.
- **`update` de equipe/transporte não repete a checagem do módulo** (só `create` chama `assertModuloLigado`); `update` de quarto também não. Editar um cadastro existente não depende do módulo continuar ligado.

## Rotas

Todas atrás de `JwtAuthGuard`, `RolesGuard`, `EventTenantGuard` e `@Roles(...ADMIN_ROLES)` — dev, super admin e admin da igreja; **financeiro não entra** em nenhum dos três módulos.

| Módulo | Método | Caminho |
| --- | --- | --- |
| Quartos | `POST` / `GET` | `/events/:idEvent/bedrooms` |
| Quartos | `GET` / `PUT` / `DELETE` | `/events/:idEvent/bedrooms/:idBedrooms` |
| Equipes | `POST` / `GET` | `/events/:idEvent/teams` |
| Equipes | `GET` / `PUT` / `DELETE` | `/events/:idEvent/teams/:idTeam` |
| Transporte | `POST` / `GET` | `/events/:idEvent/transport` |
| Transporte | `GET` / `PUT` / `DELETE` | `/events/:idEvent/transport/:idTransport` |

`POST`, `PUT` e `DELETE` devolvem `204`. O `EventTenantGuard` garante que o evento da URL é da igreja de quem pediu; dentro do serviço, `findOne`/`update`/`delete` sempre buscam o registro filtrando por `eventId` também, para um id de quarto/equipe/transporte de outra igreja não vazar por aqui.

## Campos

### Quarto (`BedroomDto`) — `Bedrooms`

- **`name`:** nome do quarto (padrão no banco: "Quarto sem nome").
- **`capacity`:** capacidade numérica, opcional.
- **`note`:** observação livre, opcional.
- **`tags`:** lista livre de rótulos (ex. "Família", "Masculino") — informativa, não trava alocação.
- **`groupTags`:** nomes de grupos de inscrição (`GroupRoles.name`) que podem ocupar o quarto. Vazio = quarto aberto a qualquer inscrito; preenchido = restrito a quem está inscrito em algum desses grupos.
- **`usersId`:** ids dos ocupantes.

### Equipe (`TeammDto`) — `Team`

- **`name`, `capacity`, `note`:** mesmos campos de quarto e transporte, sem `tags`/`groupTags` — equipe não tem restrição por grupo de inscrição.
- **`usersId`:** ids dos membros comuns.
- **`usersLeadersId`:** ids dos líderes. Quem aparece nas duas listas vira líder — a checagem, em `createRelations`, dá prioridade ao papel de líder no `upsert`.

### Transporte (`TransportDto`) — `Transport`

- Mesmos campos de quarto: `name`, `capacity`, `note`, `tags`, `groupTags`, `usersId`.

## Regras de alocação

- **Só quem está inscrito no evento entra (`assertUsersNoEvento`, os três serviços):** todo `usersId`/`usersLeadersId` enviado no corpo precisa corresponder a uma inscrição (`EventOnUsers`) no evento da URL. Sem essa checagem, um id de pessoa de outra igreja — ou de alguém que nem se inscreveu — viraria ocupante e apareceria na lista do evento, no PDF (crachá/quadrante) e na fila do check-in. Falha: `400` "Há pessoas na lista que não estão inscritas neste evento".
- **Restrição por grupo (`assertUsersAllowed`, quarto e transporte):** quando `groupTags` não é vazio, cada pessoa da lista precisa pertencer a pelo menos um dos grupos de inscrição citados (`GroupRoles.name`, via `EventOnUsersRolesRegistration` → `RolesRegistration` → `GroupRoles`). Quem está fora recebe `400` com os nomes: "Quarto restrito a [tags]. Fora desse(s) grupo(s): [nomes]" (mensagem equivalente para transporte). Uma pessoa pode estar em mais de um grupo — a checagem passa se ela está em **qualquer um** dos grupos exigidos. Essa validação vale tanto para a montagem manual do quarto/transporte quanto para a alocação automática do check-in — não é regra só de uma tela.
- **Capacidade (`capacity`) não é imposta pelo backend nos três módulos:** os serviços não recusam criar/atualizar quando o número de ocupantes passa da capacidade informada. O campo existe para a tela mostrar ocupação, mas nada nestes serviços bloqueia o excedente.
- **`update` substitui a lista de ocupantes:** quem estava na lista antiga e não está na nova é desvinculado (`deleteMany` com `NOT: { userId: { in: novaLista } }`); quem é novo é vinculado (`createRelations`, que já evita duplicar vínculo existente).

## O que acontece quando alguém sai do evento

Em `EventService` (`src/event/event.service.ts`), ao remover a inscrição de uma pessoa de um evento (linhas ~2590–2600) ou ao apagar o evento inteiro (linhas ~2726–2734), a mesma transação também apaga:

- `BedroomsOnUsers` da pessoa (ou de todo o evento);
- `TransportOnUsers` da pessoa (ou de todo o evento);
- `TeamOnUsers` da pessoa (ou de todo o evento).

Ou seja: sair do evento tira a pessoa do quarto, do transporte e da equipe automaticamente — sem isso o lugar continuaria contando como ocupado por alguém que não está mais inscrito.

## Relação com o quadrante

O quadrante (`src/quadrante`) é construído em cima das equipes: `QuadranteModule` importa `TeamModule` e usa `TeamService.findAll` como fonte de dados. Ver `docs/quadrante.md`.

## Tela correspondente

Front (`ic-front/docs`): `admin-quartos-equipes-transporte.md`.
