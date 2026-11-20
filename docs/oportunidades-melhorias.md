# Oportunidades — melhorias planejadas

Melhorias levantadas depois da primeira versão do módulo (commit `759ae26`).
O que existe hoje está em [oportunidades.md](oportunidades.md); a tela, em
`ic-front/docs/oportunidades.md`. A ordem é a de prioridade.

> **Implementado em 20/11/2026.** O estado atual está em
> [oportunidades.md](oportunidades.md), que vale mais que este plano. Mudou
> em relação ao que está abaixo:
>
> - **redes sociais:** um campo para cada rede (LinkedIn, Instagram,
>   Facebook, GitHub, TikTok, X e site), e não uma lista de links;
> - **banco:** imagem, salário e formulário moram no JSON `Opportunity.data`
>   (objeto, como `Event.data`); `closesAt` é coluna porque a consulta filtra
>   por ela; as respostas são um objeto por id do campo
>   (`OpportunityInterest.answers`);
> - **descrição em HTML:** sem sanitizar no backend, como nas notícias. Só é
>   mostrada pelo visualizador do Quill.
>
> Decisões do "Em aberto": salário vazio não aparece; os campos padrão
> nascem opcionais; para mudar a candidatura, retira e manda de novo; editar
> o formulário com candidaturas é permitido (a resposta guarda o rótulo);
> criar e editar a vaga é uma página.

## 1. Avisar os membros quando sai uma vaga

Hoje o membro só descobre uma vaga se abrir a tela. O sininho já existe
([notificacoes.md](notificacoes.md)) e o app também o lê.

- Em `criar()`, chamar `notificar()` (`src/notificacoes/notificar.ts`) para
  os membros da igreja (`User.memberChurchId`), menos quem publicou, dentro
  do `seguro()`: falhar o aviso não pode derrubar a publicação.
- Novo valor `OPPORTUNITY` no enum `NotificationType` (migration).
- Reabrir uma vaga não notifica de novo (`@@unique([type, sourceId])` já
  garante).
- Clicar na notificação abre os detalhes da vaga (seção 2).

## 2. Cards, detalhes da vaga e página de candidatura

Hoje o card mostra a descrição inteira (até 4000 caracteres), o que estica a
grade, e o botão registra o interesse direto no card. O fluxo passa a ser:
**card → modal de detalhes → página de candidatura**.

### 2.1 Card

Segue o cartaz dos eventos (`CartazDoEvento`, em
`src/features/events/components/cards.tsx`), nas cores do módulo
(`TemaDoModulo`):

- **Imagem no topo**, geralmente a logo da empresa. Logo costuma ser
  quadrada e com fundo próprio: `object-fit: contain` sobre um fundo
  tingido na cor do módulo, sem cortar. Sem imagem, o ícone `Work` no mesmo
  fundo.
- Título e empresa.
- Linha de informações com ícones: local, salário oferecido (se houver) e
  **"Encerra em dd/mm"**, ou "Encerra hoje" e "Faltam N dias" quando estiver
  perto (`contagemRegressiva`, já usado nos eventos).
- Selo **✓ Candidatura enviada** quando a pessoa já se candidatou.
- Sem descrição no card (no máximo 2 linhas, com `line-clamp`).
- O card inteiro é clicável (`ButtonBase`) e abre o modal.
- Grade: a mesma de hoje (3 colunas na tela grande, 2 no tablet, 1 no
  celular).

### 2.2 Modal de detalhes

`ResponsiveModal`, como o modal de notícias:

- Imagem, título, empresa e local.
- Salário oferecido: um valor ou uma faixa, ou nada.
- **Data final para se candidatar** (seção 3).
- Publicada em.
- Descrição completa.
- Botão **Candidatar-me**, que leva à página de candidatura. Quem já se
  candidatou vê **Ver candidatura** e **Retirar candidatura**.

### 2.3 Página de candidatura (`/oportunidades/:id/candidatura`)

É uma página, e não outro modal: o formulário pode ser longo, e no celular
o modal fica apertado. Ter endereço próprio também deixa a notificação e um
link compartilhado chegarem direto nela.

- Cabeçalho com a imagem, o título da vaga e a empresa.
- **Seus dados:** nome, e-mail e celular, vindos do perfil (só leitura, com
  link para `/perfil`). Se faltar celular, a página pede que a pessoa
  complete o perfil antes de enviar; sem isso, quem oferece a vaga recebe
  só o e-mail.
- Os campos do formulário da vaga, na ordem que o admin definiu (seção 4).
- Aviso de privacidade: nome, contato e tudo o que for preenchido vão para
  quem oferece a vaga.
- **Enviar candidatura** volta para `/oportunidades` com aviso de sucesso.
- Vaga encerrada ou vencida: a página mostra o motivo e não deixa enviar.

## 3. Data final para se candidatar

Hoje a vaga fica aberta até o admin lembrar de encerrar.

- Campo opcional `closesAt` ("aberta até"), no formulário da vaga.
- A consulta do membro e o envio da candidatura tratam `closesAt` vencido
  como vaga encerrada. Sem cron: o filtro resolve.
- No painel, a vaga vencida aparece em **Encerradas**.
- Aparece no card e no modal (seção 2).

## 4. Formulário de candidatura montado por quem publica

O clique em **Tenho interesse** vira uma candidatura com formulário. Cada
vaga tem o seu, e quem publica a vaga o monta.

### 4.1 Campos da vaga

Além do que já existe (título, empresa, local, descrição):

- **Imagem:** opcional. Reaproveita `uploadImageFirebase` +
  `resolveImageExtension` (`src/utils/uploadImgFirebase.ts`), caminho
  `oportunidades/<id>/imagem`. Trocar sobrescreve; excluir a vaga apaga o
  arquivo.
- **Salário oferecido:** opcional. Um valor (`salaryMin` preenchido,
  `salaryMax` nulo) ou uma faixa (os dois, com `salaryMin <= salaryMax`).
  Em `Decimal(12, 2)`, como `titheAmount`.
- **Data final** (seção 3).

### 4.2 O formulário

A vaga nova já nasce com quatro campos padrão:

| Campo padrão | O que o candidato preenche |
| --- | --- |
| **Currículo** | um PDF, até 5 MB |
| **Pretensão salarial** | um valor ou uma faixa (mín. e máx.) |
| **Mensagem** | texto livre, até 1000: quem é, por que quer a vaga |
| **Redes sociais** | até 5 links (LinkedIn, Instagram, portfólio…) |

Quem publica pode:

- **remover** qualquer campo padrão (removido, não aparece para o
  candidato);
- marcar cada campo como **obrigatório** ou **opcional**;
- **adicionar** perguntas próprias, de quatro tipos:
  - **resposta livre** (até 2000);
  - **seleção** (select: escolhe uma opção);
  - **caixas de marcação** (checkbox: escolhe várias);
  - **opção única** (radio: escolhe uma, com todas visíveis);
- **mudar a ordem** dos campos (setas subir/descer).

Regras:

- Cada campo padrão aparece no máximo uma vez. Removido, pode voltar pelo
  botão de adicionar.
- Pergunta própria: enunciado de até 200 caracteres. Os três tipos de
  escolha pedem de 2 a 20 opções.
- No máximo 20 campos por formulário.
- Nos campos padrão, o rótulo é fixo; só muda se é obrigatório.

### 4.3 Validação no envio (backend)

O backend lê o formulário da vaga e confere a candidatura campo a campo. A
tela também valida, mas quem decide é a API.

- Os obrigatórios estão presentes. Em caixas de marcação, obrigatório
  significa pelo menos uma marcada.
- **Currículo:** PDF (`resolveDocumentExtension` já aceita
  `application/pdf`), até 5 MB.
- **Pretensão salarial:** números `>= 0` e `min <= max`.
- **Redes sociais:** URLs `http(s)` (`IsUrl`).
- **Seleção e opção única:** a resposta é uma das opções da pergunta.
  **Caixas de marcação:** só opções da lista.
- Campo que não está no formulário é ignorado.

### 4.4 No painel (admin)

- O formulário da vaga fica pequeno para o modal de hoje. Recomendo passar
  a criação e a edição para uma página (`/admin/oportunidades/nova` e
  `/admin/oportunidades/:id`) com duas seções: **A vaga** e **Formulário de
  candidatura**.
- O editor do formulário mostra os campos em lista. Cada linha tem rótulo,
  tipo, chave **Obrigatório**, subir/descer e remover. As perguntas de
  escolha abrem o editor de opções. Embaixo, **Adicionar campo** (os padrão
  removidos e os quatro tipos de pergunta).
- A janela de interessados mostra, por candidato, as respostas na ordem do
  formulário e o botão **Baixar currículo**.
- O PDF exportado mantém a tabela (nome, celular, e-mail) e ganha um bloco
  por candidato com as respostas. Os currículos são baixados à parte.

### 4.5 Banco (proposta)

`Opportunity`:

| Campo | Tipo |
| --- | --- |
| `imageUrl` | `String?` |
| `salaryMin`, `salaryMax` | `Decimal(12, 2)?` |
| `closesAt` | `DateTime?` |
| `form` | `Json @default("[]")`: `[{ id, tipo, rotulo, obrigatorio, opcoes? }]` |

`tipo` vale `CURRICULO`, `PRETENSAO_SALARIAL`, `MENSAGEM`, `REDES_SOCIAIS`
(os padrão), `TEXTO`, `SELECAO`, `CAIXAS` ou `OPCAO_UNICA` (os próprios).

`OpportunityInterest`:

| Campo | Tipo |
| --- | --- |
| `answers` | `Json @default("[]")`: `[{ campoId, tipo, rotulo, valor }]` |

Formato do `valor` por tipo:

- `CURRICULO`: o caminho no bucket (não a URL; ver 4.6).
- `PRETENSAO_SALARIAL`: `{ min, max? }`.
- `REDES_SOCIAIS` e `CAIXAS`: lista de textos.
- Os demais tipos: texto.

Decisões:

- Formulário e respostas em `Json`: são sempre lidos junto da vaga e da
  candidatura, nunca consultados à parte. Tabelas de campos e de respostas
  não compram nada hoje.
- A resposta guarda uma cópia do rótulo: se o admin editar ou remover o
  campo depois, as candidaturas antigas continuam legíveis.
- Vagas que já existem ficam com `form = []`. A candidatura delas é o
  clique simples de hoje, só com os dados do perfil.

### 4.6 Privacidade do currículo

- `uploadImageFirebase` devolve uma URL pública e sem token. **Currículo não
  pode seguir esse caminho.** Guardar só o caminho
  (`oportunidades/<vagaId>/curriculos/<uuid>.pdf`) e servir por uma rota do
  admin que confere a igreja e devolve uma URL assinada de curta duração
  (`getSignedUrl`) ou o próprio arquivo.
- O cascade do banco não apaga o bucket. Excluir a vaga, a candidatura ou a
  conta precisa apagar os currículos (e a imagem) no service.

### 4.7 Rotas

| Método | Rota | Mudança |
| --- | --- | --- |
| `GET` | `/oportunidades` | passa a trazer `imageUrl`, salário e `closesAt` |
| `GET` | `/oportunidades/:id` | **nova**: a vaga com o formulário, para a página de candidatura (membro da igreja; de outra igreja, `404`) |
| `POST` | `/oportunidades/:id/interesse` | `multipart/form-data`: `respostas` (JSON) + `curriculo` (arquivo), ambos opcionais |
| `DELETE` | `/oportunidades/:id/interesse` | apaga também o currículo do bucket |
| `POST`/`PUT` | `/churches/:churchId/oportunidades[/:id]` | aceitam salário, `closesAt` e `form` |
| `PUT`/`DELETE` | `/churches/:churchId/oportunidades/:id/imagem` | **nova**: troca ou remove a imagem (multipart, como a foto do usuário) |
| `GET` | `/churches/:churchId/oportunidades/:id/interessados/:userId/curriculo` | **nova**: o currículo, para o admin da igreja da vaga |

### 4.8 Impacto

- **App mobile (`ic-app`):** usa `GET /oportunidades` e
  `POST /oportunidades/:id/interesse`. O POST vazio de hoje continua valendo
  para as vagas sem campo obrigatório; com algum obrigatório, o app antigo
  recebe `400` com a mensagem. Atualizar `ic-app/docs/`.
- **Textos:** "interesse" vira "candidatura" nas telas (a rota pode manter o
  nome).

## 5. Vaga encerrada some para quem se candidatou

Quando o admin encerra, a vaga sai da tela do membro, e ele não consegue
mais retirar a candidatura (a API deixa, a tela não chega lá).

- Em `abertas()`: `OR: [{ isOpen: true }, { interests: { some: { userId } } }]`.
- O card aparece com o selo **Encerrada** e só deixa ver e retirar a
  candidatura.

## 6. Ajustes pequenos

- Links na descrição da vaga não são clicáveis. Uma saída é a descrição usar
  o editor que notícias e termos já usam (`ReactQuill` /
  `ReactQuillViewer`). O HTML precisa ser sanitizado no backend.
- A API devolve `createdBy` ("publicada por"), mas o painel não mostra:
  mostrar ou tirar do `select`.

## Em aberto

- Salário oferecido vazio: mostrar "A combinar" ou não mostrar nada?
- Os campos padrão nascem opcionais, ou o currículo nasce obrigatório?
- O candidato pode editar a candidatura depois de enviada, ou só retirar e
  mandar de novo?
- Editar o formulário de uma vaga que já tem candidaturas: permitir (com a
  cópia do rótulo) ou travar?
- Criar e editar a vaga continua em modal ou vai para a página sugerida em
  4.4?
