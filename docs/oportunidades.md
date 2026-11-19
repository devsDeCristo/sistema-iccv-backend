# Oportunidades

Módulo do plano (`ChurchModule.OPPORTUNITIES`) em que o admin da igreja
publica vagas de emprego — na própria igreja ou na empresa de um membro —, os
membros dela demonstram interesse, e o admin exporta a lista de interessados
para mandar a quem ofereceu a vaga. Tela correspondente em
`ic-front/docs/oportunidades.md`.

## Regras

- **Só membros:** o lado do membro (`/oportunidades`) responde apenas a quem
  é membro de uma igreja (`User.memberChurchId`, ver [membros.md](membros.md))
  ativa e com o módulo no plano; os outros levam `403`. A igreja sai do
  cadastro da pessoa, nunca da requisição: o membro só vê e só se interessa
  pelas vagas da igreja dele. Vaga de outra igreja responde `404`, sem dizer
  que existe.
- **Quem publica:** só o admin da igreja (`ADMIN_ROLES`: admin, dev e super
  admin). A tesouraria não entra. A rota da igreja passa pelo
  `ChurchTenantGuard` (admin **da igreja da URL**) e pelo `ModuloGuard`, e o
  service confere que a vaga é dessa igreja (`daIgrejaOu404`): trocar o id na
  URL não mexe na vaga de outra igreja.
- **Campos:** `titulo` (até 120), `empresa` — quem oferece, a igreja ou a
  empresa de um membro, texto livre (até 120) —, `descricao` (até 4000) e
  `local` opcional (até 120; vazio grava nulo). Tudo com `trim`.
- **Situação (`isOpen`):** nasce aberta. Encerrada some da tela dos membros e
  recusa interesse novo (`409`); os interessados que já vieram ficam para o
  admin. Reabrir devolve aos membros.
- **Edição parcial:** `PUT` com qualquer parte (`AtualizarOportunidadeDto`):
  o formulário manda tudo; encerrar/reabrir manda só `aberta`. Campo ausente
  não muda.
- **Interesse:** um por pessoa e vaga (chave `opportunityId + userId`);
  repetir não duplica. Retirar o interesse apaga só a linha da própria pessoa
  e não exige ser membro ainda nem a vaga aberta — o dado é dela.
- **O que vai para o admin:** de cada interessado, nome, e-mail, celular e
  foto, e a data do interesse. A tela do membro avisa que, ao se interessar,
  nome, celular e e-mail são repassados a quem oferece a vaga.
- **Exportação:** um PDF com nome, celular e e-mail dos interessados, gerado
  na tela a partir da lista que a API já entrega (os interessados vêm junto
  de cada vaga em `GET /churches/:churchId/oportunidades`); não há rota de
  exportação.
  Se a igreja passar de centenas de vagas, separar os interessados numa rota
  própria (`ponytail:` no service).
- **Excluir** apaga a vaga e os interessados junto. Para só tirar dos
  membros, encerra-se.
- **Fora do plano:** o membro não vê (o item some do menu, e a API recusa) e
  o painel recusa; nada é apagado.

Testes: `src/oportunidades/oportunidades.spec.ts`.

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/oportunidades` | membro de igreja com o módulo | as vagas abertas da igreja dele, com `interessei` |
| `POST` | `/oportunidades/:id/interesse` | membro da igreja da vaga | demonstra interesse (vaga aberta) |
| `DELETE` | `/oportunidades/:id/interesse` | qualquer logado | retira o próprio interesse |
| `GET` | `/churches/:churchId/oportunidades` | admin da igreja | todas as vagas (abertas e encerradas), com quem publicou e os interessados |
| `POST` | `/churches/:churchId/oportunidades` | admin da igreja | `{ titulo, empresa, descricao, local?, aberta? }` |
| `PUT` | `/churches/:churchId/oportunidades/:id` | admin da igreja | edita, encerra (`{ aberta: false }`) ou reabre |
| `DELETE` | `/churches/:churchId/oportunidades/:id` | admin da igreja | exclui a vaga e os interessados |

## Banco

`Opportunity` (`opportunities`): igreja, título, empresa, descrição, local,
`isOpen`, quem publicou (`createdById`, `SetNull` se a conta for apagada) e
datas. `OpportunityInterest` (`opportunity_interests`): o par vaga + pessoa e
a data. Apagar a igreja apaga as vagas; apagar a vaga ou a conta apaga os
interesses.

Migration `20261119120000_modulo_oportunidades`: acrescenta `OPPORTUNITIES`
ao enum `ChurchModule` e cria as duas tabelas. Só acrescenta: nenhuma igreja
ganha o módulo até o super admin pô-lo num plano. Testada aplicando todas as
migrations num Postgres vazio (o banco bateu com o schema) e com o service
real nele: membro de outra igreja, fora do plano, vaga encerrada, recorte do
admin e a cascata.

## Auditoria

`Opportunity` passa pelo log como "Oportunidade" (tabela principal) e
`OpportunityInterest` como "Interesse em oportunidade".

Arquivos: `src/oportunidades/` (controller, service, DTOs e spec).
