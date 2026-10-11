# Membros e famílias

Os membros de cada igreja — o recorte, entre todos os usuários do sistema, de quem é dela — e as famílias em que eles se juntam. Os dizimistas do financeiro **são** estes membros — todo membro é um dizimista em potencial (`docs/financeiro.md`).

Código: `src/membros` (controller, service, DTOs), campos em `User` e o modelo `Family` (`prisma/schema.prisma`).

## Modelo

- **Uma igreja por pessoa:** `User.memberChurchId` (com `memberSince`). É campo, e não lista, para o próprio banco garantir que ninguém seja membro de duas igrejas. A gravação de membro é condicional (`updateMany ... where memberChurchId: null`): duas igrejas colocando a mesma pessoa ao mesmo tempo não sobrescrevem uma à outra; a segunda recebe 409.
- **Planilha de dízimos:** importar a planilha no financeiro (só o admin) também coloca como membro quem ainda não é de nenhuma igreja — ver `docs/financeiro.md`.
- **Pedido da inscrição:** `User.requestedChurchId`. Escolher uma igreja na inscrição **não** torna a pessoa membro: vira um pedido, que o admin da igreja aceita (vira membro) ou recusa. Sem isso, marcar o nome de uma igreja bastava para entrar na lista de membros — e no financeiro — dela.
- **"Outra" igreja:** `User.otherChurchName`, o nome que a pessoa escreveu. Só informativo: aparece na busca de Membros para o admin decidir. Some quando a pessoa vira membro de alguma igreja.
- **Família:** `Family { id, churchId, name }` e `User.familyId`. Cada pessoa em uma família no máximo, e só membros da mesma igreja entram nela. Família que fica sem ninguém é apagada. Deixar de ser membro tira da família.

## Inscrição e cadastro

- `POST /users` (público) aceita `requestedChurchId` (precisa ser uma igreja **ativa**; senão 400 "Escolha uma igreja da lista") ou `otherChurchName`. Com igreja escolhida, o nome livre é descartado.
- `GET /public/churches` (sem login): as igrejas ativas, só `id` e `name`, para o select da inscrição.
- `PUT /users/:id` e o perfil **descartam** `requestedChurchId` e `otherChurchName`: a pessoa não troca de igreja sozinha depois da inscrição. Quem coloca e tira é a igreja, aqui.

## Quem acessa

`ADMIN_ROLES` + `ChurchTenantGuard`: só o **admin da igreja da rota** (e dev/super admin). O financeiro não entra no módulo — nem quem é financeiro desta igreja e admin de outra. Ele vê os membros como dizimistas, em `GET /churches/:churchId/financeiro/dizimistas`, sem pedidos nem famílias. Toda escrita confere ainda que a pessoa ou a família da URL é desta igreja (404 caso contrário): membro por `{ id, memberChurchId }`, pedido por `{ id, requestedChurchId }`, família por `{ id, churchId }`.

## Rotas (`/churches/:churchId`)

| Rota | O que faz |
| --- | --- |
| `GET membros` | Membros (com família), famílias (com quantos membros) e pedidos pendentes |
| `GET membros/busca?busca=` | Busca quem colocar como membro |
| `POST membros` | `{ userId }`: coloca como membro. 409 se já é daqui ou de outra igreja ("Esta pessoa é membro de X. Quem administra lá precisa tirá-la antes.") |
| `POST membros/:userId/aceitar` | Aceita o pedido da inscrição |
| `POST membros/:userId/recusar` | Recusa o pedido (a pessoa continua com o cadastro) |
| `DELETE membros/:userId/familia` | Tira da família |
| `DELETE membros/:userId` | Deixa de ser membro: sai da família e perde o valor do dízimo combinado (os lançamentos continuam) |
| `POST familias` | `{ nome, userIds }`: nova família com esses membros |
| `PATCH familias/:id` | `{ nome?, adicionar? }`: renomeia e/ou junta mais membros (que saem da família anterior) |
| `DELETE familias/:id` | Desfaz a família (as pessoas continuam membros) |

## Busca de pessoas

`filtroDaBusca`: o **CPF completo** (11 dígitos, com ou sem máscara), ou **pelo menos dois nomes** (cada um com 2+ letras), todos presentes no nome completo, sem diferenciar maiúsculas ("maria souza" acha "Maria Aparecida Souza"). Um nome só não busca: o sistema é de todas as igrejas, e "Maria" traria metade do cadastro. Volta no máximo 20, com nome, foto, CPF pela metade e a situação: membro de qual igreja, se pediu para entrar nesta, ou a igreja que escreveu em "Outra".

## Auditoria

`Family` passa pelo log como as outras tabelas ("Família"); os campos novos de `User` aparecem nas alterações de "Cadastro".

## Migration

`20261011170000_membros_e_familias`: só adiciona as colunas em `users` (nulas) e cria `families`; não mexe em dado existente. Ninguém vira membro sozinho com ela: os usuários de hoje começam sem igreja de membro, e cada igreja os coloca.

Testado num Postgres vazio com todas as migrations: busca (CPF, dois nomes, um nome só), pedido aceito e recusado, uma igreja por pessoa, família só com membros da igreja, família vazia apagada, recorte por igreja (outra igreja não aceita pedido nem desfaz família que não é dela) e a regra do financeiro (dizimistas são os membros; sair da igreja zera o valor do dízimo).
