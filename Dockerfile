# syntax=docker/dockerfile:1

# Mesma versão de Node em todos os stages: ABI diferente entre build e runtime
# quebra módulos nativos (bcrypt, sharp).
ARG NODE_VERSION=20.18.0

# --------------------------------------------------------------- deps (prod)
# node_modules apenas de produção, compilado com o toolchain disponível.
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app

RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y \
       build-essential node-gyp openssl pkg-config python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Copiado antes do código: a camada só é invalidada quando o lockfile muda.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

# O Prisma Client tem que ser gerado dentro do node_modules que vai pra imagem
# final — gerar no stage de build e não copiar deixaria o client faltando.
COPY prisma ./prisma
RUN npx prisma generate

# -------------------------------------------------------------------- build
# Stage descartável: precisa das devDependencies (@nestjs/cli, typescript).
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app

RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y \
       build-essential node-gyp openssl pkg-config python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN yarn build

# ------------------------------------------------------------------ runtime
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# openssl é exigido pelo query engine do Prisma.
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y openssl \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json yarn.lock ./

# prisma/ precisa existir em runtime: o start.sh roda `prisma migrate deploy`.
COPY prisma ./prisma

# mail.service.ts monta o path dos templates com process.cwd()/src/mail/templates,
# então a pasta de origem tem que existir na imagem — não só o dist.
COPY src/mail/templates ./src/mail/templates

COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ARG COMMIT_HASH
ARG COMMIT_DATE
ENV COMMIT_HASH=$COMMIT_HASH
ENV COMMIT_DATE=$COMMIT_DATE

# Usuário sem privilégio já existe na imagem oficial do Node.
USER node

EXPOSE 5000
CMD ["./start.sh"]
