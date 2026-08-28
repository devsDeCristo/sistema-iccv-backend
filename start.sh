#!/bin/sh
set -e

# O Swarm ignora `depends_on`: no primeiro boot da stack o Postgres ainda está
# rodando o initdb quando a API sobe, e o migrate morreria na conexão. Sem esta
# espera o container sai, e só o restart_policy (10s) resolve — log poluído e
# task marcada como failed. 10 x 3s cobre o initdb com folga.
echo "Running database migrations..."
i=1
while :; do
  if npx prisma migrate deploy; then
    break
  fi
  if [ "$i" -ge 10 ]; then
    echo "❌ migrate deploy falhou após $i tentativas"
    exit 1
  fi
  echo "⏳ banco indisponível (tentativa $i/10) — nova tentativa em 3s"
  i=$((i + 1))
  sleep 3
done

# NÃO rodar `prisma generate` aqui: o client já vem gerado da imagem
# (Dockerfile, stage deps) a partir deste mesmo schema.prisma, que é imutável
# dentro do container. Além de inútil, falharia: node_modules é do root e o
# processo roda como `node` (EACCES).

# O entrypoint compilado é dist/src/main.js, não dist/main.js: prisma/seed.ts
# entra na compilação e o tsc aninha a saída sob dist/src.
# `yarn start` (nest start) não serve aqui — depende do @nestjs/cli, que é
# devDependency e não existe na imagem de produção.
echo "Starting application..."
exec node dist/src/main.js
