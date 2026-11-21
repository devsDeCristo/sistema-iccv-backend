# Oportunidades

Módulo do plano (`ChurchModule.OPPORTUNITIES`) em que o admin da igreja
publica vagas de emprego (na própria igreja ou na empresa de um membro), cada
uma com o seu formulário de candidatura. Os membros da igreja se candidatam,
e o admin exporta as candidaturas para mandar a quem ofereceu a vaga. Tela
correspondente em `ic-front/docs/oportunidades.md`.

## Regras

- **Só membros:** o lado do membro (`/oportunidades`) responde apenas a quem
  é membro de uma igreja (`User.memberChurchId`, ver [membros.md](membros.md))
  ativa e com o módulo no plano; os outros levam `403`. A igreja sai do
  cadastro da pessoa, nunca da requisição: o membro só vê as vagas da igreja
  dele e só se candidata a elas. Vaga de outra igreja responde `404`, sem
  dizer que existe.
- **Quem publica:** o admin da igreja (`ADMIN_ROLES`: admin, dev e super
  admin) publica direto. O **membro propõe**, e a proposta só vai ao ar
  depois que o admin aprova (ver "Propostas dos membros"). A tesouraria não
  entra. A rota da igreja passa pelo
  `ChurchTenantGuard` (admin **da igreja da URL**) e pelo `ModuloGuard`, e o
  service confere que a vaga é dessa igreja (`daIgrejaOu404`): trocar o id na
  URL não mexe na vaga de outra igreja.
- **Campos da vaga:** `titulo` (até 120), `empresa` (quem oferece: a igreja
  ou a empresa de um membro, texto livre, até 120), `descricao` (HTML do
  editor, até 20000; as vagas antigas são texto puro) e `local` opcional (até
  120; vazio grava nulo). Tudo com `trim`. Opcionais:
  - `encerraEm`: o último dia para se candidatar (`AAAA-MM-DD`, vale até
    23:59:59 de Brasília);
  - `salario`: o salário oferecido, um valor (`{ min }`) ou uma faixa
    (`{ min, max }`, `max >= min`);
  - `formulario`: o formulário de candidatura (abaixo);
  - a imagem, geralmente a logo da empresa (rota própria), com a cor
    dominante dela (`cor`), que a tela calcula ao escolher o arquivo e usa
    para tingir o crachá dos detalhes. Cor inválida é ignorada. Remover a
    imagem tira a cor junto.
- **Descrição em HTML, limpa no servidor** (`descricao.ts`, com
  `sanitize-html`): com as propostas, qualquer membro escreve HTML que
  outros leem. Ao gravar (admin ou proposta), fica só a formatação do
  editor numa lista fechada: parágrafo, negrito, itálico, sublinhado,
  riscado, sub/sobrescrito, títulos, citação, código, listas, `span`, as
  classes `ql-*`, cor, fundo, alinhamento e links `http`/`https`/`mailto`,
  sempre com `target="_blank"` e `rel="noopener noreferrer"`. Script,
  eventos (`onerror`), `style` livre, iframe e **imagem** saem (o editor
  embute imagem em base64). Se depois da limpeza não sobra texto, a API
  responde `400` "Descreva a vaga". As descrições gravadas antes disso (só
  do admin) não foram limpas de novo; a tela continua mostrando todas pelo
  visualizador do Quill.
- **Situação:** a vaga nasce aberta (`isOpen`). Encerrada à mão (`isOpen:
  false`) ou **vencida** (`closesAt` passou) é a mesma coisa para o membro:
  sai da vitrine e recusa candidatura nova (`409`). Não há cron: o filtro da
  consulta resolve (`recebendo()`). As respostas devolvem `encerrada` já
  calculado. Reabrir devolve a vaga aos membros; reabrir uma vencida exige
  tirar ou mudar a data.
- **Edição parcial:** `PUT` com qualquer parte (`AtualizarOportunidadeDto`).
  Campo ausente não muda; `encerraEm: null` e `salario: null` tiram o prazo e
  o salário. O formulário vem inteiro e substitui o anterior.
- **Aviso aos membros:** publicar uma vaga aberta (ou reabrir uma que nasceu
  encerrada) notifica os membros da igreja (`notificarOportunidade`, tipo
  `OPPORTUNITY`), uma vez por vaga. Ver [notificacoes.md](notificacoes.md).
  Igreja sem o módulo no plano, ou desativada, não avisa ninguém: o super
  admin publica em qualquer igreja (o `ModuloGuard` não vale para ele), mas o
  membro não abriria a vaga.
- **Excluir** apaga a vaga, as candidaturas e os arquivos delas (imagem e
  currículos). Para só tirar dos membros, encerra-se.
- **Conta bloqueada:** as rotas do membro não passam pelo `RolesGuard`, então
  o bloqueio é conferido em `igrejaDoMembro`, na mesma busca da igreja: quem
  foi bloqueado leva `401` mesmo com o token ainda valendo.
- **Fora do plano:** o membro não vê (o item some do menu, e a API recusa) e
  o painel recusa; nada é apagado.

## Propostas dos membros

Qualquer membro que vê as vagas (membro de igreja ativa, com o módulo no
plano, sem bloqueio) pode **propor** uma vaga. A proposta passa pelo admin.

- **Situação (`status`):**
  - `PENDING`: proposta esperando o admin;
  - `APPROVED`: no ar (a vaga do admin já nasce assim);
  - `REJECTED`: recusada, arquivada no painel.
  - O padrão do banco é `PENDING`, o lado seguro: caminho que esquecer de
    dizer não publica nada.
- **Só a aprovada existe para os membros:** a lista, o detalhe e a
  candidatura começam todos pelo filtro `PUBLICADA` (`status = APPROVED`).
  Pendente e recusada respondem `404` a quem não é admin, como vaga de outra
  igreja.
- **Para onde vai:** a igreja sai do cadastro de quem propõe, nunca da
  requisição. `createdById` e `proposedById` são essa pessoa.
- **Limite:** até 5 propostas pendentes por pessoa ao mesmo tempo (`409`
  depois disso), para ninguém encher a fila do admin.
- **Quem propôs** (rotas em `/oportunidades/propostas`):
  - vê as próprias propostas **da igreja de que é membro agora**, com a
    situação e o motivo da recusa;
  - **edita e retira** enquanto está pendente (imagem também). `aberta` não
    é dele: a proposta nasce aberta;
  - **aprovada, vê os candidatos e baixa os currículos**, como o admin. Isso
    vale enquanto ela for membro desta igreja (com o módulo e sem
    bloqueio): mudou de igreja, perde o acesso. O aviso de privacidade da
    candidatura diz que os dados ficam com a igreja e com quem oferece a
    vaga.
- **O admin** (aba Pendentes do painel):
  - edita a proposta antes de decidir (a mesma rota de editar);
  - **aprova**: a proposta vai ao ar (`isOpen: true`), os membros são
    avisados (menos quem propôs, que recebe "aprovada") e quem propôs passa a
    ver os candidatos;
  - **recusa**, com motivo opcional (até 500), que vai para quem propôs. A
    recusada fica em Recusadas, e o admin pode excluí-la.
  - `reviewedById` e `reviewedAt` guardam quem decidiu e quando.
- **Sem atropelo:** aprovar, recusar, editar e retirar só valem a partir de
  `PENDING`, e numa instrução só (`updateMany`/`deleteMany` com a situação
  no `where`). Dois admins decidindo juntos, ou quem propôs editando enquanto
  o admin aprova: quem chega depois leva `409` e nada muda.
- **Avisos** ([notificacoes.md](notificacoes.md)):
  - `OPPORTUNITY_PROPOSAL` para os admins da igreja (sai do sininho deles
    quando a proposta é decidida, retirada ou excluída);
  - `OPPORTUNITY_PROPOSAL_ANSWERED` para quem propôs, uma vez por decisão;
  - `OPPORTUNITY` (vaga nova) para os membros, só depois de aprovada.

## Formulário de candidatura

Regras e formato em `src/oportunidades/formulario.ts`.

- A vaga nova nasce com cinco campos prontos, todos opcionais: **Currículo**,
  **Pretensão salarial**, **Mensagem**, **LinkedIn** e **Instagram**.
- O admin pode tirar qualquer um deles, exigir qualquer um, mudar a ordem e
  acrescentar:
  - **campos prontos**: um para cada rede social (LinkedIn, Instagram,
    Facebook, GitHub, TikTok, X e site/portfólio), além dos três acima;
  - **perguntas próprias**: resposta livre (`TEXTO`), seleção (`SELECAO`),
    caixas de marcação (`CAIXAS`) ou opção única (`OPCAO_UNICA`).
- Campo pronto tem id e rótulo fixos (`curriculo`, `pretensao_salarial`,
  `mensagem`, `rede-<rede>`) e aparece no máximo uma vez. Pergunta própria
  tem enunciado de até 200 caracteres. As de escolha pedem de 2 a 20 opções
  (até 100 caracteres cada). O formulário tem no máximo 20 campos.
- Vaga sem campos (as que existiam antes do formulário ficam assim): a
  candidatura é um clique, só com os dados do perfil.

### O que o candidato manda

`POST /oportunidades/:id/interesse` em `multipart/form-data`:

- `respostas`: JSON, `{ [campoId]: valor }`;
- `curriculo`: o arquivo.

Os dois são opcionais conforme o formulário. A API confere campo a campo
(`validarRespostas`):

| Campo | Regra |
| --- | --- |
| Currículo | PDF (mime **e** assinatura `%PDF-`), até 5 MB |
| Pretensão salarial | `{ min, max? }`, números `>= 0`, `max >= min` |
| Mensagem | até 1000 caracteres |
| Rede social | link `http(s)` do domínio da rede (`https://` opcional na digitação); site/portfólio aceita qualquer domínio |
| Resposta livre | até 2000 caracteres |
| Seleção e opção única | uma das opções |
| Caixas de marcação | só opções da lista; obrigatório significa ao menos uma |

Campo que não está no formulário é ignorado. Repetir a candidatura não
duplica nem troca o que foi enviado: para mudar, retira e manda de novo.
Retirar apaga só a candidatura da própria pessoa (e o currículo dela) e não
exige ser membro ainda nem a vaga aberta: o dado é dela.

### Currículo

- Fica no bucket em `oportunidades/<vagaId>/curriculos/<userId>-<uuid>.pdf`,
  gravado por `src/oportunidades/bucket.ts`, **sem URL pública**. O caminho
  fica na resposta, mas nunca sai da API (`semCaminho`).
- O admin baixa pela rota do currículo, que confere a igreja da vaga e manda
  o arquivo.
- O registro de atividades não guarda as respostas
  (`REDACTED_FIELDS` em `prisma.service.ts`, ver
  [logs-e-auditoria.md](logs-e-auditoria.md)): fica só o fato de que a
  pessoa se candidatou, sem o caminho do currículo nem os dados pessoais.
- **Regras do Firebase Storage** (ficam no console, fora deste
  repositório): o sigilo do currículo hoje depende de o caminho ser
  impossível de adivinhar (uuid) e nunca sair da API. Para fechar de vez,
  as regras não devem permitir leitura de `oportunidades/*/curriculos/**`.
  A API lê pelo Admin SDK, que não passa pelas regras. As regras somam
  permissões (basta uma liberar): se houver um
  `match /{allPaths=**} { allow read: if true; }`, é ele que precisa
  excluir esse caminho.
- O cascade do banco não apaga o bucket. Por isso o service apaga os
  currículos ao retirar a candidatura e ao excluir a vaga, e
  `UserService.excluir` e `ChurchService.remove` apagam os da conta e os da
  igreja.

### Acompanhamento (etapa e anotação)

Quem conduz a vaga (o admin da igreja e, na vaga proposta e aprovada, quem
propôs, enquanto for membro desta igreja) acompanha cada candidatura:

- `stage` (`InterestStage`): `NEW` (padrão), `REVIEWING`, `INTERVIEW`,
  `SELECTED` e `DISCARDED`;
- `note`: a anotação interna, até 2000 caracteres (vazia apaga);
- `trackedAt`: quando um dos dois mudou.

`PATCH .../interessados/:userId` com `{ etapa?, nota? }`; campo ausente não
muda. **O candidato não vê nenhum dos dois**: o detalhe e a lista do membro
selecionam só a data e as respostas da própria candidatura (há teste para
isso). Retirar a candidatura apaga o acompanhamento junto.

### O que vai para o admin

De cada candidato: nome, e-mail, celular e foto, a data e as respostas. Cada
resposta guarda o tipo e o rótulo de quando foi enviada: editar ou tirar o
campo depois não apaga o que já foi respondido. A tela do membro avisa que
nome, celular, e-mail e o que ele preencher vão para quem oferece a vaga, e
pede o celular no perfil antes de deixar enviar.

A exportação é um PDF gerado na tela a partir da lista que a API já entrega:
a tabela de contato e um bloco por candidato com as respostas. Os currículos
vão à parte. Se a igreja passar de centenas de vagas, separar as
candidaturas numa rota própria (`ponytail:` no service).

Testes: `src/oportunidades/oportunidades.spec.ts` e
`src/oportunidades/propostas-rotas.spec.ts` (a ordem das rotas).

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/oportunidades/propostas` | membro de igreja com o módulo | as propostas da pessoa nesta igreja, com a situação (a aprovada vem com os candidatos) |
| `POST` | `/oportunidades/propostas` | membro de igreja com o módulo | propõe uma vaga (o mesmo corpo da criação do admin, sem `aberta`) |
| `PUT` | `/oportunidades/propostas/:id` | quem propôs | edita a proposta pendente |
| `DELETE` | `/oportunidades/propostas/:id` | quem propôs | retira a proposta pendente |
| `PUT`/`DELETE` | `/oportunidades/propostas/:id/imagem` | quem propôs | troca ou remove a imagem da proposta pendente |
| `GET` | `/oportunidades/propostas/:id/interessados/:userId/curriculo` | quem propôs | o currículo de um candidato da vaga aprovada |
| `PATCH` | `/oportunidades/propostas/:id/interessados/:userId` | quem propôs | `{ etapa?, nota? }` de um candidato da vaga aprovada |
| `GET` | `/oportunidades` | membro de igreja com o módulo | as vagas recebendo candidatura e as encerradas em que se candidatou, com `interessei` e `encerrada` (sem o formulário) |
| `GET` | `/oportunidades/:id` | membro da igreja da vaga | a vaga com o formulário e `minhaCandidatura`; encerrada só para quem se candidatou |
| `POST` | `/oportunidades/:id/interesse` | membro da igreja da vaga | candidata-se (multipart: `respostas` + `curriculo`) |
| `DELETE` | `/oportunidades/:id/interesse` | qualquer logado | retira a própria candidatura (e o currículo) |
| `GET` | `/churches/:churchId/oportunidades` | admin da igreja | todas as vagas, com quem publicou, o formulário e as candidaturas |
| `POST` | `/churches/:churchId/oportunidades` | admin da igreja | `{ titulo, empresa, descricao, local?, aberta?, encerraEm?, salario?, formulario? }` (sem formulário: o padrão) |
| `PUT` | `/churches/:churchId/oportunidades/:id` | admin da igreja | edita, encerra (`{ aberta: false }`) ou reabre |
| `PUT` | `/churches/:churchId/oportunidades/:id/imagem` | admin da igreja | troca a imagem (multipart: `imagem`, até 5 MB, e `cor`, a cor dominante dela em `#rrggbb`, opcional) |
| `DELETE` | `/churches/:churchId/oportunidades/:id/imagem` | admin da igreja | remove a imagem |
| `GET` | `/churches/:churchId/oportunidades/:id/interessados/:userId/curriculo` | admin da igreja | o PDF do currículo do candidato |
| `PATCH` | `/churches/:churchId/oportunidades/:id/interessados/:userId` | admin da igreja | `{ etapa?, nota? }`: o acompanhamento do candidato |
| `POST` | `/churches/:churchId/oportunidades/:id/aprovar` | admin da igreja | aprova a proposta pendente |
| `POST` | `/churches/:churchId/oportunidades/:id/recusar` | admin da igreja | `{ motivo? }`: recusa a proposta pendente |
| `DELETE` | `/churches/:churchId/oportunidades/:id` | admin da igreja | exclui a vaga, as candidaturas e os arquivos |

`PropostasDeOportunidadeController` é registrado **antes** de
`OportunidadesController` no módulo: senão `GET /oportunidades/:id` (com
`ParseUUIDPipe`) pegaria `/oportunidades/propostas` e responderia `400`. O
teste `propostas-rotas.spec.ts` monta os controllers na ordem real do módulo
e confere.

O app mobile (`ic-app`) usa as rotas do membro. O `POST` sem corpo continua
valendo para vaga sem campo obrigatório; com algum obrigatório, o app antigo
recebe `400` com a mensagem.

## Banco

`Opportunity` (`opportunities`): igreja, título, empresa, descrição, local,
`isOpen`, `closesAt`, `status` (`OpportunityStatus`: `PENDING`, `APPROVED`,
`REJECTED`; padrão `PENDING`), quem publicou (`createdById`), quem propôs
(`proposedById`), quem decidiu (`reviewedById`, `reviewedAt`), o motivo da
recusa (`rejectionReason`), datas e `data`. As três pessoas são `SetNull` se
a conta for apagada. `data` é um JSON livre, como `Event.data`:

```json
{
  "imagemUrl": "https://…",
  "cor": "#3f51e0",
  "salario": { "min": 2000, "max": 2500 },
  "formulario": {
    "campos": [
      { "id": "curriculo", "tipo": "CURRICULO", "rotulo": "Currículo", "obrigatorio": true },
      { "id": "rede-linkedin", "tipo": "REDE_SOCIAL", "rede": "linkedin", "rotulo": "LinkedIn", "obrigatorio": false },
      { "id": "…uuid", "tipo": "CAIXAS", "rotulo": "Dias livres", "opcoes": ["Seg", "Ter"], "obrigatorio": false }
    ]
  }
}
```

`closesAt` é coluna, e não JSON, porque a consulta filtra por ela.

`OpportunityInterest` (`opportunity_interests`): o par vaga + pessoa, a data,
o acompanhamento (`stage`, `note`, `trackedAt`) e `answers`, um JSON (objeto)
por id do campo:

```json
{
  "curriculo": { "tipo": "CURRICULO", "rotulo": "Currículo", "valor": { "caminho": "oportunidades/…pdf", "nome": "cv.pdf" } },
  "pretensao_salarial": { "tipo": "PRETENSAO_SALARIAL", "rotulo": "Pretensão salarial", "valor": { "min": 2500 } }
}
```

Apagar a igreja apaga as vagas; apagar a vaga ou a conta apaga as
candidaturas.

Migrations:

- `20261119120000_modulo_oportunidades`: acrescenta `OPPORTUNITIES` ao enum
  `ChurchModule` e cria as duas tabelas. Só acrescenta: nenhuma igreja ganha
  o módulo até o super admin pô-lo num plano.
- `20261120120000_oportunidades_formulario`: `closesAt` e `data` (padrão
  `{}`) na vaga, `answers` (padrão `{}`) na candidatura e `OPPORTUNITY` no
  enum `NotificationType`. As vagas que já existiam ficam sem formulário.

- `20261122120000_acompanhamento_de_candidaturas`: o enum
  `InterestStage` e as colunas `stage` (padrão `NEW`), `note` e
  `trackedAt` na candidatura. As que já existiam entram como `NEW`.
- `20261121120000_propostas_de_oportunidade`: o enum `OpportunityStatus`,
  as colunas `status` (padrão `PENDING`), `proposedById`, `reviewedById`,
  `reviewedAt` e `rejectionReason`, e `OPPORTUNITY_PROPOSAL` e
  `OPPORTUNITY_PROPOSAL_ANSWERED` no `NotificationType`. **As vagas que já
  existiam passam a `APPROVED`** (`UPDATE` na própria migration):
  continuam no ar.

Todas foram testadas aplicando as migrations num Postgres vazio (o banco
bateu com o schema) e com o service real nele. A última também foi aplicada
sobre um banco com uma vaga já gravada, que continuou `APPROVED`. O fluxo de
propostas inteiro foi conferido no banco real: propor, invisível aos
membros, edição de outra pessoa ou igreja barrada, aprovar (segunda
aprovação `409`), candidatar, quem propôs ver os candidatos e perder o
acesso ao mudar de igreja, recusar com motivo, retirar e o limite de 5.

## Auditoria

`Opportunity` passa pelo log como "Oportunidade" (tabela principal) e
`OpportunityInterest` como "Interesse em oportunidade".

Arquivos: `src/oportunidades/` (controller, service, DTOs, `formulario.ts`,
`bucket.ts` e spec).
