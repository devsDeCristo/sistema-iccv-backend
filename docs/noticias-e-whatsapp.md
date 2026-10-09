# Notícias e WhatsApp

O mural de notícias (`src/news`) publica avisos para os inscritos e pode
disparar cada um também nos grupos de WhatsApp dos eventos. O disparo em si
sai pela sessão de WhatsApp da igreja (`src/whatsapp`), pareada com o número
dela via Baileys. Tela correspondente em `ic-front/docs/noticias.md`.

## Notícia (`News`)

| Campo | Significado |
| --- | --- |
| `title`, `summary`, `content` | título, chamada curta (feed) e corpo em HTML (editor rico) |
| `isPublished` | rascunho não aparece no feed |
| `publishedAt` | data da **primeira** publicação — republicar depois de virar rascunho não muda a ordem |
| `churchId` | igreja dona da notícia (quem administra/reenvia); `null` só no histórico do super admin |
| `eventId` | público do anúncio: `null` é geral (todo mundo vê), preenchido restringe a quem está inscrito ou na lista de espera do evento |
| `imageUrl` | capa opcional, sobe para o Firebase |

Arquivos: `src/news/news.service.ts`, `src/news/news.controller.ts`, `src/news/dto/news.dto.ts`.

## Rotas

| Método | Caminho | Quem pode | O que faz |
| --- | --- | --- | --- |
| GET | `/news` | qualquer autenticado | feed: só publicadas, ordenadas por `publishedAt`/`createdAt` desc |
| GET | `/news/admin` | admin | lista completa, com rascunho e status de envio por grupo |
| GET | `/news/whatsapp-groups` | admin | grupos de inscrição com link preenchido, de eventos ativos ou em teste |
| POST | `/news` | admin | cria (multipart, por causa da imagem) |
| PUT | `/news/:id` | admin | edita |
| POST | `/news/:id/whatsapp` | admin | reenvio manual para todos os destinos marcados |
| DELETE | `/news/:id` | admin | exclui |

`GET /news/admin` é rota separada da pública de propósito: o `RolesGuard`
confere o perfil no banco, porque o perfil do token pode estar defasado em até
24h — um rascunho não pode vazar por token velho.

## Regras de negócio

- **Igreja da notícia:** com um vínculo só, não há dúvida; com mais de um, vale
  a igreja do evento escolhido, e sem evento a primeira igreja do admin.
  Notícia de outra igreja não se edita, apaga nem reenvia (`403`).
- **Destinos (`groupRoleIds`):** grupos de inscrição de eventos, cada um com um
  link de convite de WhatsApp. Um admin só pode marcar grupos de eventos da
  própria igreja — misturar grupo de igreja vizinha dá `400`.
- **Campo ausente vs. vazio:** `eventId` ausente no PUT não mexe no público
  atual; string vazia volta a valer para todos. Mesma lógica de "não mexi
  nisso" usada em outras edições parciais do sistema.
- **Disparo automático:** só a virada de rascunho para publicada dispara
  (`create` com `isPublished: true`, ou `update` que muda `false → true`).
  Corrigir uma notícia já publicada não reenvia sozinho — para isso existe o
  reenvio manual.
- **Reenvio manual (`force: true`):** manda de novo para **todos** os
  destinos marcados, mesmo os que já receberam, com o texto e a imagem atuais.
- **Disparo é assíncrono:** publicar não espera o WhatsApp responder nem falha
  por causa dele; roda em segundo plano e grava o resultado por destino em
  `NewsOnGroupRoles` (`sentAt`/`error`).
- **Número de saída:** a notícia sai pelo WhatsApp da igreja dona
  (`noticia.churchId`), nunca por outro número.
- **Grupo do WhatsApp repetido:** dois grupos de inscrição podem apontar para
  o mesmo grupo de WhatsApp (mesmo link); a mensagem sai uma vez só, e o
  segundo destino é marcado como enviado também.
- **Sem link preenchido:** destino fica marcado com o erro "O grupo não tem
  link de WhatsApp preenchido", sem tentar enviar.
- **Formatação:** o HTML do editor é convertido para o texto do WhatsApp
  (negrito, itálico, listas e links viram equivalentes do aplicativo). Mensagem
  com imagem tem limite de ~950 caracteres (legenda do WhatsApp); sem imagem,
  ~3500. O excedente é cortado com reticências.
- **Eventos elegíveis:** só grupos de eventos `ACTIVE` ou `TEST` aparecem para
  disparo — evento encerrado não recebe aviso.

## Sessão de WhatsApp por igreja (`src/whatsapp`)

- **Uma sessão por igreja:** cada igreja pareia o próprio número (QR ou código
  de pareamento), via Baileys (biblioteca não oficial que fala o protocolo do
  WhatsApp Web). Estado isolado por igreja evita que a queda de uma derrube o
  QR de outra.
- **Credenciais no banco** (`WhatsappAuth`, tabela `whatsapp_auth`), não em
  disco: o container é recriado a cada deploy, e gravar em arquivo obrigaria a
  parear de novo a cada versão.
- **Leitura das chaves em lote, com cache:** enviar para um grupo pede a
  sessão de cada aparelho de cada participante, milhares de chaves num grupo
  grande. O `get` do `useDatabaseAuthState` busca todas numa consulta só
  (`findMany`). Até 09/10/2026 era uma consulta por chave, em sequência. Na
  frente do banco fica o cache em memória do Baileys
  (`makeCacheableSignalKeyStore`, 5 minutos), que poupa o banco num disparo
  para vários grupos seguidos.
- **O que a sessão ignora (`shouldIgnoreJid`):** status dos contatos, listas de
  transmissão e canais. O número recebe tudo isso, e decifrar seria trabalho
  jogado fora, porque o sistema só envia para grupos. **Grupos e conversas
  individuais não podem ser ignorados:** por eles chegam os pedidos de reenvio
  de quem não conseguiu decifrar a nossa mensagem ("Aguardando mensagem") e os
  avisos de troca de chave dos contatos.
- **Fila de envio por igreja:** todo envio passa por uma fila única com pausa
  sorteada entre 8s e 25s. Evita rajada de mensagens idênticas, que é
  assinatura de robô e motivo de bloqueio do número.
- **Reconexão automática:** ao cair, tenta de novo com espera exponencial
  (5s → 10s → 20s… até 5 minutos). Exceção: se o WhatsApp encerrou a sessão do
  lado dele (`loggedOut`/`badSession` — número removido dos aparelhos, ou
  credencial inválida), não adianta tentar: a sessão é apagada e o admin
  precisa parear de novo.
- **Ao subir o servidor:** todas as igrejas com número já pareado (`registered
  = true` nas credenciais) são reconectadas em paralelo; falha em uma não
  impede as demais.
- **Quando não há sessão conectada:** operações de uso (`sendToGroup`,
  `resolveGroupIdFromInvite`, `listGroups`) recusam com `503` e mensagem
  apontando "Configurações > Disparadores" — não abrem conexão silenciosa para
  descobrir depois que falta credencial.

### Rotas (`/churches/:churchId/whatsapp`)

Protegidas por `JwtAuthGuard` + `RolesGuard` (`ADMIN_ROLES`, fora o financeiro)
+ `ChurchTenantGuard` (o `:churchId` da URL precisa ser uma igreja administrada
por quem chama).

| Método | Caminho | O que faz |
| --- | --- | --- |
| GET | `status` | situação atual, QR e código de pareamento (tela consulta em intervalo curto) |
| POST | `connect` | abre a sessão e gera QR |
| POST | `pairing-code` | parear informando o número, sem ler QR |
| DELETE | `pairing` | cancela pareamento em andamento; número já pareado não é afetado |
| DELETE | `session` | desconecta e apaga a sessão (logout + limpa credenciais) |
| GET | `groups` | grupos do WhatsApp em que o número participa |

## O que acontece quando a sessão cai

- Enquanto está caindo/tentando reconectar, o envio de notícia falha destino a
  destino com `503`, gravado como erro em `NewsOnGroupRoles`; a notícia
  continua publicada normalmente, só o disparo é que fica pendente.
- Reconectada a sessão (rede voltou, ou admin pareou de novo), o reenvio
  manual (`POST /news/:id/whatsapp`) cobre o que ficou pendente ou com erro.
- Sessão encerrada pelo WhatsApp (não por queda de rede) não reconecta
  sozinha: a tela mostra o motivo (`lastError`) e exige novo pareamento.

## Testes

Não há `*.spec.ts` em `src/news` nem `src/whatsapp` no momento.
