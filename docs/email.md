# E-mail

O módulo `src/mail` envia os e-mails transacionais do sistema — sempre com um
gabarito HTML fixo por tipo de e-mail, preenchido com variáveis, e disparado
pelo serviço de domínio que motiva o envio (não existe um catálogo central de
"quando mandar", cada disparo é uma chamada explícita).

Arquivos: `src/mail/mail.service.ts`, `src/mail/templates/*.html`.

## Envio (`MailService`)

- **Transporte:** Gmail via Nodemailer, autenticado por OAuth2 (client id/secret
  e refresh token de variáveis de ambiente: `CLIENT_ID_SERVER_EMAIL`,
  `CLIENT_SECRET_SERVER_EMAIL`, `REFRESH_TOKEN_SERVER_EMAIL`,
  `USER_CLIENT_SERVER_EMAIL`). O access token é renovado a cada envio.
- **`loadTemplate(nome, variaveis)`:** lê o arquivo
  `src/mail/templates/<nome>.html` e substitui `{chave}` pelo valor
  correspondente — troca de texto simples, sem engine de template.
- **`sendMail({ to | bcc, subject, html, from, replyTo, text, attachments })`:**
  monta e envia a mensagem. `from` tem padrão fixo ("Igreja de Cristo Cidade
  Verde <...>") quando não informado; aceita `to` (um destinatário) ou `bcc`
  (lista), nunca os dois.
- **Falha de envio não derruba a operação:** os pontos que chamam `sendMail`
  capturam o erro e só registram no log — inscrever alguém ou redefinir senha
  não pode falhar por causa do e-mail.
- Há trechos de código comentado no arquivo (implementação anterior de
  `loadTemplate`, `sendMail` e do `from` padrão) que vale limpar quando alguém
  mexer no arquivo — não afetam o comportamento atual, mas são funcionalidade
  morta guardada em comentário.

## Cabeçalho e assinatura

- **Logo:** todos os e-mails levam a logo anexada por `cid` (`cid:logo`), não
  como URL externa — evita bloqueio de imagem remota por cliente de e-mail. É
  sempre a versão branca (`logo-branca.png`, em `src/mail/templates/assets/`),
  porque o cabeçalho dos templates é a faixa índigo da marca e a logo preta
  (`logo.png`) sumiria dentro dela.
- **Assinatura do líder espiritual:** só no e-mail de confirmação de inscrição.
  Quem assina é o `spiritualLeader` vinculado à igreja do evento
  (`Church.spiritualLeaderId`, ver `docs/igrejas.md`), com nome, e-mail e
  celular formatado. Igreja sem líder vinculado não assina nada — e-mail sem
  assinatura é preferível a um assinado por quem não responde por aquele
  evento. Isso substituiu uma assinatura fixa no template, que saía com o
  nome do pastor de uma igreja só, mesmo em e-mail de outra.
  Arquivo: `EventService.renderSignature` em `src/event/event.service.ts`.

## Templates existentes (`src/mail/templates`)

| Arquivo | Usado por | Variáveis |
| --- | --- | --- |
| `registration-confirmation.html` | confirmação de inscrição no evento | `eventTitle`, `eventDescription`, `userName`, `eventDate`, `INSERT_TICKETS` (lista de ingressos/tipos), `EVENT_BANNER` (capa/logo do evento), `LOCAL`, `ASSINATURA` |
| `password-reset-code.html` | pedido de redefinição de senha (código) | `userName`, `code`, `expiraEm` |
| `password-changed.html` | aviso de senha alterada | `userName` |
| `waiting-list-notice.html` | — | não está referenciado por nenhum serviço no código atual; o template existe mas o disparo não foi encontrado |

### Confirmação de inscrição

Disparado por `EventService.sendEmailConfirmation` (`src/event/event.service.ts`),
assunto `Confirmação de inscrição no evento <nome>`. Monta:
- **Faixa do evento** (`renderEventBanner`): capa e/ou logo do evento, com
  fallback quando faltar um dos dois (imagem quebrada é evitada renderizando
  só o que existe);
- **Ingressos** (`renderTickets`): tipo de inscrição e status, um bloco por
  ticket;
- **Local:** monta a partir dos campos livres do evento (nome do local,
  cidade/estado, bairro, endereço, CEP, número);
- Todo valor que vai para dentro do HTML é escapado (`escapeHtml`) antes de
  entrar no template — inclusive os que vêm de campo livre do evento — para
  não permitir HTML/JS injetado no e-mail.

### Redefinição de senha

Disparados por `PasswordResetService` (`src/auth/password-reset/password-reset.service.ts`):
- `sendCodeEmail`: assunto "Código para redefinir sua senha", com o código e o
  tempo de validade (`CODE_TTL_MINUTES`).
- `sendChangedEmail`: assunto "Sua senha foi alterada", avisa o dono da conta
  depois da troca — inclusive quando quem trocou não foi ele (ex.: reset via
  código), para que descubra se não foi o autor da troca.

Ambos passam por `trySend`, que engole erro de envio e só loga — a resposta ao
front é a mesma independente de o e-mail ter saído ou não.

## Testes

Não há `*.spec.ts` em `src/mail`.
