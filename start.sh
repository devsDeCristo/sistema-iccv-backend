#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

# O entrypoint compilado é dist/src/main.js, não dist/main.js: prisma/seed.ts
# entra na compilação e o tsc aninha a saída sob dist/src.
# `yarn start` (nest start) não serve aqui — depende do @nestjs/cli, que é
# devDependency e não existe na imagem de produção.
echo "Starting application..."
exec node dist/src/main.js
