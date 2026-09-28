# Crachás e geração de PDF

Geração do PDF de crachás do evento pelo servidor, com o Chrome (Puppeteer) desenhando o HTML e imprimindo. O módulo `src/pdf` reúne o que os geradores de PDF do sistema (crachá e quadrante) têm em comum: navegador compartilhado, imagens reduzidas e fonte embutida.

Arquivos: `src/cracha/*`, `src/pdf/navegador.ts`, `src/pdf/imagens.ts`, `src/pdf/fonte.ts`.

## Rota

| Método | Caminho | Quem pode | O que faz |
| --- | --- | --- | --- |
| `POST` | `/events/:idEvent/crachas/pdf` | perfis de `ADMIN_AREA_ROLES` (dev, super admin, admin, financeiro) | gera e devolve o PDF dos crachás |

É `POST` porque quem decide quais crachás entram, em que ordem e com que cabeçalho de seção é a tela (modal do painel), e isso vai no corpo da requisição. Guardas: `JwtAuthGuard`, `RolesGuard`, `EventTenantGuard`.

## Corpo da requisição (`GerarCrachasDto`)

- **`sections`:** lista de seções, até 300. Cada seção tem `title` (opcional, até 120 caracteres — vira cabeçalho da folha, em minúsculo) e `badges`, até 3000 crachás por seção.
- **`badges[].name`:** nome impresso, até 120 caracteres. A formatação (caixa alta, duas palavras) é decidida na tela; o servidor imprime o que chegou.
- **`badges[].userId`:** opcional, UUID da inscrição. Serve só para gerar o QR — sem ele, ou com um QR desligado, o crachá sai só com o nome.
- **`blankCount`:** crachás em branco no fim do PDF, para quem chega sem inscrição. Até 500, padrão 0.
- **`withQrCode`:** liga ou desliga o QR de todos os crachás da geração. Padrão `true`.

## Limite e erros

- **Sem crachá nenhum** (soma de `badges` de todas as seções + `blankCount` = 0): `400` "Nenhum crachá para gerar".
- **Acima de 3000 crachás no total** (`LIMITE_DE_CRACHAS`): `400` "São no máximo 3000 crachás por PDF". O teto existe porque um número maior é sinal de engano na tela, não de evento de verdade.
- **Evento inexistente:** `404`.

## Layout do crachá

Arquivo: `src/cracha/cracha-pdf.ts`. Quatro crachás por folha A4, 8,7 × 11 cm cada, replicando medida por medida o desenho que o front fazia com `react-pdf` (fundo, logo da igreja, logo do evento, papel rasgado, nome e QR dentro do rasgo).

- **Seções:** cada seção começa em folha nova, para o cabeçalho valer para todos os crachás dela. Os crachás em branco (`blankCount`) vão sempre para o fim, sem cabeçalho.
- **Fundo do crachá:** a capa do evento (`Event.data.coverUrl`); sem capa, uma capa padrão fixa do sistema (mesma do evento sem capa na tela). Antes, no `react-pdf`, a falta de capa **ou** de logo fazia o crachá herdar a arte fixa de outro evento — corrigido aqui.
- **Logo do evento:** `Event.data.logoUrl`; sem logo, o espaço fica vazio (não herda de outro evento).
- **QR (`codigoDoCracha`/`qrDoCracha`):** o id do inscrito em hex maiúsculo, sem hífen — o mesmo formato que o leitor de check-in do front espera (`buildBadgeCode`). Só entra QR quando o `userId` é um UUID válido; fora disso o crachá sai sem QR (melhor sem QR do que um QR que não bate com ninguém). O código usa modo alfanumérico do QR (nível de correção M, margem de 2 módulos), o que dá 25 módulos em vez de 33 — módulo maior no mesmo tamanho impresso, o que ajuda a leitura por câmera.

## Desempenho e memória (por que o código é assim)

O módulo carrega comentários de motivo no próprio código — resumo do que está documentado lá:

- **Arte fotografada uma vez (`fotografarArte`/`htmlDaArte`):** fundo, logos e papel são iguais em todo crachá da geração. Em vez de desenhar essas quatro camadas em cada um dos crachás, o Chrome desenha um crachá isolado uma única vez, tira um screenshot dele (JPEG, escala 3×, qualidade 90) e usa essa foto como fundo de todos os crachás — só o nome e o QR continuam em vetor. Com as quatro imagens em cada crachá, a impressão levava 9,5s para 200 crachás; com a foto única, 0,1s.
- **Imagens servidas por endereço, não em base64 (`servirImagens`):** cada imagem repetida (fundo, logo, papel) vira uma URL fictícia (`https://pdf.local/...`) que a própria página intercepta e responde, em vez de ir embutida em base64 em cada `<img>`. Sem isso, imagem repetida em 100 crachás já significava 34 MB de HTML e ~1,1 GB de uso do Chrome; com 300 crachás o Chrome chegava a cair, e em produção o container inteiro caía por estouro de memória, sem erro no log.
- **Geração em partes (`FOLHAS_POR_PARTE = 50`):** o Chrome mantém tudo o que desenhou até o `page.pdf()` terminar, e a memória cresce com o número de crachás — 3000 de uma vez chegavam a +550 MB. O serviço gera o PDF em partes de 50 folhas (200 crachás) e depois junta tudo com `pdf-lib`; o pico de memória fica limitado ao de uma parte, não ao total. Cada parte também cabe folgada no timeout de 120s configurado no `page.pdf()`.
- **Chrome compartilhado, com fechamento por ociosidade (`src/pdf/navegador.ts`):** um único navegador é aberto na primeira geração e reaproveitado nas seguintes — abrir o Chrome custava ~250ms por PDF. Cada geração abre e fecha só a própria página (`novaPagina`). Sem página aberta por 60 segundos (`OCIOSO_MS`), o Chrome inteiro é fechado, para não segurar memória num servidor que passa horas sem gerar PDF. O processo mata o Chrome no `exit` do Node, de forma síncrona (o único tipo de tarefa que o `exit` ainda executa).
- **Fonte embutida (`src/pdf/fonte.ts`):** a folha de estilo do Google Fonts (Arimo para o nome, Oswald para o título da seção) é baixada e embutida como `data:` uma vez por processo, em vez de o Chrome buscá-la a cada impressão (~500ms por vez). Falha ao baixar não impede a geração: o `<link>` original fica no HTML e o Chrome tenta sozinho, ou cai na fonte de reserva do CSS.
- **Artes fixas e imagens do evento em paralelo:** logo da igreja e papel rasgado (arquivos fixos em `src/cracha/assets`) são lidos e reduzidos uma vez por processo (`carregarArtesFixas`). Capa e logo do evento são baixadas do Firebase e reduzidas (`src/pdf/imagens.ts`, formatos `crachaFundo`/`crachaLogo`) com cache em memória por URL, concorrência de até 32 downloads simultâneos e timeout de 10s por imagem — foto que não chega a tempo fica de fora, sem travar o PDF inteiro.
- **Aquecimento (`aquecerImagensDoCracha`):** disparado quando o admin abre o painel do evento (de onde se baixa o crachá), começa a baixar capa, logo, artes fixas e fonte sem esperar clique em "Baixar Crachá" — o clique real geralmente já encontra tudo em cache.

## Docker

- **Chromium via `apt`, não pelo Puppeteer:** o pacote Debian já traz as bibliotecas necessárias, evitando baixar um segundo Chromium na imagem. `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` aponta o `puppeteer-core` para esse binário.
- **`--disable-dev-shm-usage`:** o `/dev/shm` do container tem só 64 MB por padrão; uma página grande de crachás estourava esse limite e derrubava o Chrome. A flag faz o Chrome usar `/tmp` em vez de `/dev/shm`.
- **`--no-sandbox` / `--disable-setuid-sandbox`:** necessários para rodar o Chrome como processo do container.

## Tela correspondente

Front (`ic-front/docs`): `admin-pdfs.md`.
