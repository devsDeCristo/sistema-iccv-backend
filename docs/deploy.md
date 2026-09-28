# Deploy

Push na `main` gera a imagem, publica no GitHub Container Registry e troca a
imagem do serviço no Docker Swarm. Tudo em `.github/workflows/build-push.yml`.
O deploy do front, com as variáveis `VITE_*`, está no repositório `ic-front`,
em `docs/deploy.md`.

## Etapas

1. **Build e push:** imagem `linux/amd64` em `ghcr.io/<repositório>`, com as tags da branch, do commit (`main-<sha>`) e `latest`. `COMMIT_HASH` e `COMMIT_DATE` entram como build-arg.
2. **Secrets do serviço:** todas as secrets do repositório e da organização viram variáveis de ambiente do serviço (ver abaixo).
3. **Atualizar o serviço:** por SSH na VM, `docker service update` do `sistema-eventos-iccv_api` com a imagem nova. O comando só retorna quando o serviço convergiu; se o healthcheck falhar, o Swarm faz rollback e o passo falha.
4. **Limpeza:** mantém as 10 versões mais recentes do package, sem apagar as tags `latest`, `main` e `homolog`.

O deploy (etapas 2 e 3) só roda na `main` e com a secret `DEPLOY_HOST` cadastrada.

## Secrets

- **Automáticas:** não é preciso declarar secret no workflow. Toda secret cadastrada em Settings > Secrets and variables > Actions > Secrets, do repositório ou da organização, é aplicada ao serviço no próximo deploy (`docker service update --env-add CHAVE=valor`).
- **Só do CI, não vão para o serviço:** `GITHUB_TOKEN`, `DEPLOY_HOST`, `DEPLOY_USER` e `DEPLOY_PASSWORD`. Secret nova que for só do CI deve entrar em `SKIP_SECRETS` no workflow.
- **Variáveis que não estão no GitHub:** continuam como estão no serviço. O `--env-add` só cria ou atualiza as que vieram.
- **Secret vazia:** é ignorada, porque aplicá-la apagaria o valor em uso.
- **Secret apagada do GitHub:** continua no serviço até um `docker service update --env-rm CHAVE` manual.
- **Transporte:** as secrets vão para a VM numa variável só, `SERVICE_SECRETS`, em base64 e mascarada no log. São pares `CHAVE=valor` separados por NUL, porque há valores com quebra de linha, como chaves privadas.

### Por que não vão para a imagem

O package do GHCR é **público**. `ENV` no Dockerfile ou build-arg viram camada da imagem, e `docker pull` seguido de `docker inspect` entregaria a URL do banco, o `JWT_SECRET` e a `PAYMENT_CREDENTIALS_KEY`, a chave que abre as credenciais de gateway de todas as igrejas. Por isso as secrets entram no serviço, no deploy, e nunca no build.

Arquivo: `.github/workflows/build-push.yml`.
