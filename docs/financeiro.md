# Financeiro (dizimistas, livro-caixa e Pluggy)

Módulo financeiro de cada igreja: quem dizima nela (**dizimistas**) e o livro-caixa (**lançamentos**), com entradas e saídas lançadas à mão e importadas do extrato dos bancos pela Pluggy.

Código: `src/financeiro` (controller, `DizimistasService`, `LancamentosService`, `categorias.ts`) e `src/pluggy/pluggy.service.ts` (leitura do extrato).

## Quem acessa

- `@Roles(...ADMIN_AREA_ROLES)` + `ChurchTenantGuard`, como a Pluggy: dev, super admin, e admin ou financeiro **da igreja da rota**. O financeiro de uma igreja não lê o caixa da outra trocando o `:churchId`.
- Além do guard, todo acesso a um registro é por `{ id, churchId }` juntos: o id de um dizimista ou lançamento de outra igreja responde 404 e não altera nada.
- Ligar um lançamento a um dizimista exige que a pessoa seja dizimista **desta** igreja (400 caso contrário).

## Rotas (`/churches/:churchId/financeiro`)

| Rota | O que faz |
| --- | --- |
| `GET dizimistas?ano=` | Lista com os números do ano (padrão: o atual) |
| `GET usuarios?busca=` | Busca quem adicionar como dizimista |
| `POST dizimistas` | `{ userId, since?, notes?, expectedAmount? }`. 409 se já é dizimista |
| `PATCH dizimistas/:id` | `{ active?, since?, notes?, expectedAmount? }` (`null` apaga data, observação ou valor) |
| `DELETE dizimistas/:id` | Tira da lista; os dízimos lançados continuam |
| `GET lancamentos?de&ate&type&category&source&busca` | Lançamentos do período, com resumo |
| `POST lancamentos` | Lançamento manual |
| `PATCH lancamentos/:id` | Edita (no importado, só categoria, descrição e dizimista) |
| `DELETE lancamentos/:id` | Apaga o manual; o importado não |
| `POST lancamentos/importar` | Importa o extrato da Pluggy |

## Dizimistas (`Tither`, tabela `tithers`)

- O dizimista é **sempre um usuário do sistema** (`userId`), marcado como dizimista de uma igreja: uma vez por igreja (`@@unique([churchId, userId])`). Campos próprios: `active`, `since` (dia, sem hora), `notes` e `expectedAmount`.
- **Valor do dízimo** (`expectedAmount`, `Decimal(12,2)`, opcional): o dízimo combinado com a pessoa. É o que a importação usa, junto com o CPF, para separar dízimo de oferta (ver abaixo). `null` no `PATCH` apaga o valor.
- **Busca de quem adicionar:** qualquer usuário do sistema, pelo nome (3+ letras, sem diferenciar maiúsculas) ou pelo CPF completo — a pessoa pode dizimar numa igreja em cujo evento nunca se inscreveu. Volta no máximo 20, só com nome, foto, CPF pela metade (`***.456.789-**`) e se já é dizimista.
- **Números do ano** (`listar`): saem dos lançamentos `INCOME` de categoria `TITHE` ligados à pessoa, manuais ou importados. Por dizimista: total no ano, meses do ano com dízimo (1 a 12) e o último dízimo (de qualquer ano). No resumo: ativos, quantos dizimaram no mês corrente, total do mês e do ano.
- **Desativar** (`active: false`) tira da contagem de ativos e faz o Pix da pessoa deixar de virar dízimo na importação; o histórico fica. **Remover** apaga a linha do dizimista; os lançamentos continuam, ligados ao usuário.
- Apagar a conta do usuário apaga o vínculo de dizimista (`Cascade`), mas não o dinheiro: o lançamento fica com `userId` nulo (`SetNull`).

## Lançamentos (`FinancialEntry`, tabela `financial_entries`)

- `type` (`INCOME`/`EXPENSE`), `category`, `amount`, `date`, `description`, `method` (Pix, dinheiro, cartão, transferência, boleto, outra), `userId` (dizimista ou quem contribuiu), `source` (`MANUAL`/`PLUGGY`), e do extrato: `externalId`, `bankAccount` ("Sicredi · Conta corrente"), `payerName`.
- **`amount` é `Decimal(12,2)`**, e não `Float` como os pagamentos de evento: o livro-caixa vive de somas (saldo do mês, total do ano), e soma de `Float` acumula erro de centavo. Sempre positivo; o sinal é o `type`. A API devolve número.
- **`date` é `@db.Date`** (dia, sem hora). Entra e sai como `"AAAA-MM-DD"`, sem passar por fuso.
- **Categorias** por tipo (`CATEGORIAS_POR_TIPO`): entradas — dízimo, oferta, doação, evento, outra entrada; saídas — água/luz/internet, aluguel, manutenção, salários e ajudas de custo, materiais, missões e ação social, evento, tarifas bancárias, outra saída. Categoria de um tipo num lançamento do outro é recusada (400).
- **Lista** (`listar`): período padrão do dia 1 do mês até hoje (em Brasília); filtros de tipo, categoria, origem e busca (descrição, pagador ou nome do dizimista). Teto de 5.000 linhas (`cortado: true` avisa a tela). O **resumo** (entradas, saídas, saldo, dízimos) é do **período inteiro**, ignorando os outros filtros de propósito: os cards dizem quanto entrou e saiu, não quanto há na tabela filtrada.
- **Importado do banco:** valor, data, tipo e forma são o que o extrato diz e não mudam (400 se tentar); categoria, descrição e dizimista sim. **Não se apaga**: o `externalId` dele é o que impede a mesma transação de voltar na próxima importação.

## Importação do extrato (Pluggy)

`POST lancamentos/importar` → `LancamentosService.importar` → `PluggyService.transacoes`.

- **Janela:** da última leitura (`PluggyIntegration.lastSyncAt`) menos 7 dias até hoje; na primeira, os últimos 90 dias. A sobreposição pega a transação que estava pendente na leitura anterior e só apareceu lançada depois.
- **O que entra:** as transações **lançadas** (`status` diferente de `PENDING`) das contas do tipo `BANK` (corrente e poupança) de cada Item ID. Conta de cartão de crédito fica de fora: a fatura já sai da conta corrente como débito, e importar as compras contaria a despesa duas vezes.
- **Sem duplicar:** `externalId` (id da transação na Pluggy) é único por igreja, e a gravação usa `createMany` com `skipDuplicates`. Rodar de novo sobre o mesmo período não duplica nada; a resposta diz quantas foram lidas, importadas e quantas já existiam.
- **Como vira lançamento** (`lancamentoDaTransacao`, em `categorias.ts`, com teste):
  - Crédito cujo CPF do pagador (`paymentData.payer.documentNumber`) é de um dizimista **ativo** da igreja → ligado a ele, e o **valor** decide a categoria:
    - igual ao valor do dízimo dele (`expectedAmount`, comparado ao centavo) → `TITHE`;
    - outro valor → `OFFERING` (oferta), ainda ligada a ele;
    - dizimista sem valor cadastrado → `TITHE` (o Pix do dízimo é o caso comum).
    
    Continua sendo um palpite: quem manda dízimo e oferta juntos num Pix só, ou mudou o valor do dízimo sem atualizar o cadastro, cai em oferta — o financeiro corrige a categoria (e o valor no cadastro).
  - Outro crédito → "outra entrada", sem pessoa.
  - Débito → categoria pela categoria da Pluggy quando há equivalente claro (tarifas → tarifas bancárias; luz, água, telefone, internet → água/luz/internet; aluguel; salários); o resto, "outra saída".
  - Forma: Pix → Pix; TED/DOC/TEF → transferência; boleto → boleto; o resto fica vazio.
  - Data: o dia da transação **em Brasília** (uma transação às 01:30 UTC do dia 4 é do dia 3).
- Credencial recusada ou integração desligada → 400 com a mensagem; falha de rede ou da Pluggy → 502 ("tente de novo em alguns minutos"). Depois de importar, `lastSyncAt` é atualizado (o card da integração mostra "Última leitura há…").
- Por enquanto a importação é **por botão**: não há webhook da Pluggy nem rotina agendada.

## Auditoria

`Tither` e `FinancialEntry` passam pelo log de auditoria como as outras tabelas, com os rótulos "Dizimista" e "Lançamento financeiro" (`MODEL_LABELS`), e são tabelas principais (`MAIN_MODELS`). A importação grava um `createMany` só.

## Migration

`20261011150000_financeiro`: só cria as duas tabelas, os enums e os índices; não mexe em nada existente. `20261011160000_valor_do_dizimo`: só adiciona a coluna `expectedAmount` (nula) em `tithers`. Testada aplicando todas as migrations num Postgres vazio e rodando os serviços contra ele (somas em `Decimal`, importação repetida sem duplicar, recorte por igreja).
