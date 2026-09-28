# Documentação dos módulos

Cada arquivo descreve um módulo do servidor: o que ele faz, as regras que
valem nele, as rotas e onde está no código. Serve de contexto para quem
(pessoa ou IA) for mexer no backend.

| Módulo | Pasta | Arquivo |
| --- | --- | --- |
| **Acesso** | | |
| Autenticação e permissões | `src/auth`, `src/decorators` | [autenticacao.md](autenticacao.md) |
| Usuários | `src/user` | [usuarios.md](usuarios.md) |
| Igrejas | `src/church` | [igrejas.md](igrejas.md) |
| Termos de Uso | `src/terms` | [termos.md](termos.md) |
| **Eventos** | | |
| Eventos | `src/event` | [eventos.md](eventos.md) |
| Inscrições | `src/event` | [inscricoes.md](inscricoes.md) |
| Inscrição em grupos (janela) | `src/event/event-groups.ts` | [inscricao-em-grupos.md](inscricao-em-grupos.md) |
| Loja e produtos | `src/event/event-products.ts` | [loja-e-produtos.md](loja-e-produtos.md) |
| Check-in | `src/checkin` | [checkin.md](checkin.md) |
| Quartos, equipes e transporte | `src/bedrooms`, `src/team`, `src/transport` | [quartos-equipes-transporte.md](quartos-equipes-transporte.md) |
| Crachás e PDF | `src/cracha`, `src/pdf` | [crachas-e-pdf.md](crachas-e-pdf.md) |
| Quadrante | `src/quadrante` | [quadrante.md](quadrante.md) |
| **Pagamentos** | | |
| Pagamentos | `src/payment`, `src/gateways` | [pagamentos.md](pagamentos.md) |
| PagBank | `src/gateways/pagbank` | [pagbank.md](pagbank.md) |
| Mercado Pago | `src/gateways/mercadopago` | [mercadopago.md](mercadopago.md) |
| **Comunicação e operação** | | |
| Notícias e WhatsApp | `src/news`, `src/whatsapp` | [noticias-e-whatsapp.md](noticias-e-whatsapp.md) |
| E-mail | `src/mail` | [email.md](email.md) |
| Dashboard | `src/dashboard` | [dashboard.md](dashboard.md) |
| Logs e auditoria | `src/logs`, `src/context`, `src/prisma` | [logs-e-auditoria.md](logs-e-auditoria.md) |
| Rotinas agendadas | `src/cron` | [cron.md](cron.md) |

As telas estão documentadas no repositório `ic-front`, em `docs/` (índice em
`docs/README.md`).

## Manter atualizado

Toda modificação, da mais simples à mais complexa, atualiza o `.md` do módulo
que ela toca, no mesmo commit. Módulo novo ganha arquivo próprio e uma linha na
tabela acima. Quando a regra vale também na tela, atualize o `.md` do mesmo
módulo no `ic-front`. Os `.md` não entram na imagem Docker (`**/*.md` no
`.dockerignore`).
