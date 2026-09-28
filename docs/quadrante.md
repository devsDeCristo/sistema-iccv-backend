# Quadrante

O quadrante é a lista de equipes do evento com os dados de contato de cada pessoa (celular, e-mail, aniversário), em tela e em PDF. O módulo gera o mesmo conteúdo dos dois jeitos: a rota `GET` alimenta a tela e a rota `GET .../pdf` devolve o PDF pronto para impressão.

Arquivos: `src/quadrante/quadrante.controller.ts`, `src/quadrante/quadrante.service.ts`, `src/quadrante/quadrante-pdf.ts`, `src/quadrante/quadrante.module.ts` (importa `TeamModule`, já que o quadrante é montado em cima das equipes do evento).

## Rotas

| Método | Caminho | Quem pode | O que devolve |
| --- | --- | --- | --- |
| `GET` | `/events/:idEvent/quadrante` | quem `assertPodeVer` libera (ver abaixo) | equipes já ordenadas, dados do evento (nome, período, cores, logo, capa) |
| `GET` | `/events/:idEvent/quadrante/pdf` | idem | o PDF gerado |

O controller não usa `@Roles` nem `EventTenantGuard`: quem pode ver não é definido por perfil administrativo, e sim por `QuadranteService.assertPodeVer`, chamado no início das duas rotas. Usar o `EventTenantGuard` aqui recortaria por engano o admin de outra igreja que esteja inscrito neste evento como participante comum — e é justamente esse caso que a checagem precisa aceitar.

## Quem pode gerar/ver

Regra em `QuadranteService.assertPodeVer`:

1. **Sem usuário autenticado:** `403` "Usuário não autenticado".
2. **Evento inexistente:** `404` "Evento não encontrado".
3. **Quadrante desligado no evento** (`quadranteAtivo(event.data)` falso): `403` "O quadrante está desligado nas configurações deste evento" — vale até para o admin da própria igreja.
4. **Quadrante ligado:** entram o super admin, o admin da igreja dona do evento (`perfilNaIgreja(...) === Role.ADMIN`), e qualquer pessoa **inscrita no evento** (linha em `EventOnUsers`). Quem não está em nenhuma dessas situações recebe `403` "O quadrante só pode ser visto por quem está inscrito no evento".

### Quando o quadrante está ativo (`src/event/event-quadrante.ts`)

- Controlado por `Event.data.showQuadrante`. Diferente dos módulos do evento (quartos, equipes, transporte), aqui **ausente é desligado** — o quadrante expõe e-mail, celular e data de nascimento de toda a equipe, e abrir esses dados é decisão explícita de quem organiza, nunca efeito de subir código novo.
- Mesmo com `showQuadrante: true`, o quadrante fica desligado se o módulo de equipes (`teams`) estiver desligado no evento: sem equipes cadastráveis não há o que mostrar.
- `generatePdf` também recusa (`400`) quando o evento não tem nenhuma equipe cadastrada: "Não é possível gerar o PDF: este evento ainda não possui equipes cadastradas."

## Conteúdo (`findQuadrante`)

- **Equipes:** vêm de `TeamService.findAll`, ordenadas dentro de cada equipe com líderes primeiro e, dentro de cada grupo, ordem alfabética por nome — a mesma ordem que o PDF antigo gerado no front usava.
- **Evento:** nome, `startDate`/`endDate` (formatados como período em português, ex. "De 12 a 14 de março de 2026"), `logoUrl`, `coverUrl` e `colors` (`Event.data.colors`), usados tanto na tela quanto no PDF.

## PDF (`quadrante-pdf.ts` e `generatePdf`)

- **Dois documentos juntados em um (`pdf-lib`):** a capa, sem margem nem cabeçalho, e as páginas das equipes, com cabeçalho e rodapé em todas. O motivo é técnico: o Puppeteer desenha o cabeçalho/rodapé (`headerTemplate`/`footerTemplate`) em toda página do PDF gerado, inclusive por cima de uma capa sem margem — gerar os dois documentos separados é o único jeito de a capa sair limpa.
- **Capa:** A4 paisagem, fundo com a capa do evento (ou gradiente nas cores do evento, sem capa), logo, nome do evento, período e totais de equipes/pessoas.
- **Páginas de equipes:** A4 paisagem, cabeçalho (logo + nome do evento + período) e rodapé (nome do evento + número de página) em todas, um cartão por pessoa com foto (ou iniciais, sem foto), nome, selo de líder quando aplicável, celular, e-mail e aniversário.
- **Cores do evento (`paletaDoEvento`):** a paleta parte de `colors.primary`/`secondary`/`tertiary` (formato hex; azul e violeta são o padrão sem cor configurada). Cada equipe recebe uma das três cores em rodízio. Uma cor é escurecida automaticamente (`legivelNoBranco`) até garantir contraste de leitura (4,5:1) sobre fundo branco — evita, por exemplo, um amarelo da identidade do evento sumir no papel.
- **Formatação de dados:** `escapeHtml` em todo texto vindo do banco; celular formatado como `(DD) NNNNN-NNNN`; aniversário mostrado só como dia e mês (não a idade), lido em UTC porque a data é gravada à meia-noite UTC.

### Desempenho e memória

Reaproveita a mesma infraestrutura do crachá:

- **Imagens reduzidas e embutidas (`src/pdf/imagens.ts`):** fotos de perfil, capa e logo passam pelo mesmo pipeline de download com concorrência limitada (32 simultâneos), timeout de 10s por imagem e cache em memória por URL. Um evento real com 145 fotos somando 64 MB de originais vira ~850 KB de imagens já reduzidas ao tamanho de impressão — sem isso o Chrome estourava o timeout de 30s tentando baixar tudo, ou parte dos downloads simultâneos falhava.
- **Aquecimento (`aquecerImagens`):** disparado assim que a tela `GET` do quadrante é aberta, sem esperar a resposta — quando a pessoa clica em "Baixar PDF" as fotos já estão em cache ou a caminho.
- **Chrome compartilhado (`src/pdf/navegador.ts`) e fonte embutida (`src/pdf/fonte.ts`):** mesmo mecanismo do crachá — ver `docs/crachas-e-pdf.md`.

## Tela correspondente

Front (`ic-front/docs`): `quadrante.md`.
