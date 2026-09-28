# Termos de Uso

Guarda as versões dos Termos de Uso no banco (`TermsDocument`) e o aceite de
cada usuário (`TermsAcceptance`). Cobre publicação de versão nova, consulta da
versão vigente (rota pública) e o aceite pelo titular, inclusive a decisão
sobre dados sensíveis quando ela é pedida junto. Tela correspondente no
`ic-front`: `docs/termos-de-uso.md`.

## Rotas

| Método | Rota | Quem pode | Ação |
| --- | --- | --- | --- |
| `GET` | `/terms` | público | texto vigente (versão, conteúdo, resumo, data) |
| `GET` | `/terms/status` | autenticado | situação do aceite de quem está logado |
| `POST` | `/terms/accept` | autenticado | aceita a versão vigente, com IP e aparelho |
| `GET` | `/terms/versions` | `SUPER_ADMIN_ROLES` (dev, super admin) | histórico de versões, com contagem de aceites |
| `POST` | `/terms/versions` | `SUPER_ADMIN_ROLES` | publica uma versão nova |

`GET /terms` é pública de propósito: a página `/termos` abre antes de a pessoa
ter conta. As demais exigem sessão; `aceitar` é sempre sobre o próprio
usuário — ninguém aceita termos em nome de outro.

Arquivos: `src/terms/terms.controller.ts`, `src/terms/terms.service.ts`,
`src/terms/dto/aceitar-termos.dto.ts`, `src/terms/dto/publicar-termos.dto.ts`.

## Versões (`TermsDocument`)

- Termos valem para a **plataforma inteira**, não por igreja: só dev ou super
  admin publicam.
- **Versão:** a data da publicação no fuso de Brasília (`"2026-09-24"`); uma
  segunda publicação no mesmo dia vira `"2026-09-24.2"`. Em caso de corrida
  entre duas publicações no mesmo instante (conflito de chave única), a que
  perder tenta o número seguinte, até 3 tentativas.
- **Nenhuma versão anterior é alterada** ao publicar uma nova — é o texto que
  alguém aceitou, e ele precisa continuar existindo exatamente como era. Cada
  `TermsAcceptance` aponta para a `version` que a pessoa aceitou.
- **Vigente:** a mais recente publicada — é a que `GET /terms` mostra e a que
  `POST /terms/accept` registra.
- **`requiresAcceptance` (mudança relevante):** liga ou desliga se aquela
  publicação exige aceite de novo de todo mundo.
  - `true`: todo mundo precisa aceitar essa versão (ou qualquer uma publicada
    depois dela) no próximo acesso.
  - `false`: correção de texto — publica sem pedir aceite de novo. Quem já
    tinha aceitado uma versão anterior à última `requiresAcceptance: true`
    continua "em dia".
- **Campos do DTO de publicação:** `content` (HTML do editor, 50 a 200.000
  caracteres — a página pública limpa o HTML antes de mostrar), `summary`
  (até 10 frases do quadro "Em resumo", 300 caracteres cada) e
  `requiresAcceptance` (booleano).

## Aceite pelo usuário

`POST /terms/accept`, corpo `AceitarTermosDto`:

| Campo | Tipo | Regra |
| --- | --- | --- |
| `accepted` | `true` (literal) | obrigatório e explícito — é uma declaração, não um efeito colateral do envio |
| `sensitiveDataConsent` | `boolean`, opcional | decisão sobre saúde/religião já cadastradas — ver abaixo |

- Grava a versão **vigente** no momento do aceite, com IP e `User-Agent`
  (cortado em 255 caracteres, mesmo limite do registro de login).
- Aceitar de novo a mesma versão não duplica (`upsert` por `userId + version`).
- Sem nenhum termo publicado, não há o que aceitar — a chamada não falha, só
  não grava nada.
- Esse mesmo registro (`registrarAceite`) também é chamado no cadastro
  público (`POST /users` com `acceptedTerms: true`), com o IP e aparelho de
  quem se cadastrou — ver `docs/usuarios.md`.

### `GET /terms/status`

Responde:

- `versao`: a vigente (ou `null`, sem termos publicados).
- `aceito`: se a pessoa aceitou a versão exigida (a mais recente com
  `requiresAcceptance: true`) ou qualquer versão publicada depois dela.
- `consentimentoDadosSensiveis`: se `sensitiveConsentAt` está preenchido.
- `precisaDecidirDadosSensiveis`: `true` quando a pessoa já tem
  religião/diabetes/hipertensão gravados (de antes de o consentimento
  específico existir) mas nunca decidiu sobre eles — sinaliza que a tela
  precisa perguntar. A migração que criou o consentimento não apagou dados
  antigos; a decisão fica com o titular.

### Consentimento de dados sensíveis embutido no aceite

Quando `sensitiveDataConsent` vem no corpo de `POST /terms/accept`:

- `true`: autoriza o tratamento (mantém a data original de consentimento, se
  já existia).
- `false`: revoga — apaga `religion`, `diabetes`, `hypertensive` e a data de
  consentimento.
- Omitido: nada muda.

A regra de fundo é a mesma usada no cadastro e na edição de usuário — ver
`aplicarConsentimento` em `docs/usuarios.md` (dados sensíveis e consentimento).
