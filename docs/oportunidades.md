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
- **Quem publica:** só o admin da igreja (`ADMIN_ROLES`: admin, dev e super
  admin). A tesouraria não entra. A rota da igreja passa pelo
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
- **Descrição em HTML:** a tela só a mostra pelo visualizador do Quill
  (`ReactQuillViewer`), que reconstrói o texto a partir do modelo dele e
  descarta o que não é formatação, como nas notícias. Não renderizar
  `description` como HTML cru em outro lugar.
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
- **Excluir** apaga a vaga, as candidaturas e os arquivos delas (imagem e
  currículos). Para só tirar dos membros, encerra-se.
- **Fora do plano:** o membro não vê (o item some do menu, e a API recusa) e
  o painel recusa; nada é apagado.

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
- O cascade do banco não apaga o bucket. Por isso o service apaga os
  currículos ao retirar a candidatura e ao excluir a vaga, e
  `UserService.excluir` e `ChurchService.remove` apagam os da conta e os da
  igreja.

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

Testes: `src/oportunidades/oportunidades.spec.ts`.

## Rotas

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
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
| `DELETE` | `/churches/:churchId/oportunidades/:id` | admin da igreja | exclui a vaga, as candidaturas e os arquivos |

O app mobile (`ic-app`) usa as rotas do membro. O `POST` sem corpo continua
valendo para vaga sem campo obrigatório; com algum obrigatório, o app antigo
recebe `400` com a mensagem.

## Banco

`Opportunity` (`opportunities`): igreja, título, empresa, descrição, local,
`isOpen`, `closesAt`, quem publicou (`createdById`, `SetNull` se a conta for
apagada), datas e `data`. `data` é um JSON livre, como `Event.data`:

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

`OpportunityInterest` (`opportunity_interests`): o par vaga + pessoa, a data
e `answers`, um JSON (objeto) por id do campo:

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

As duas foram testadas aplicando todas as migrations num Postgres vazio (o
banco bateu com o schema) e com o service real nele.

## Auditoria

`Opportunity` passa pelo log como "Oportunidade" (tabela principal) e
`OpportunityInterest` como "Interesse em oportunidade".

Arquivos: `src/oportunidades/` (controller, service, DTOs, `formulario.ts`,
`bucket.ts` e spec).
