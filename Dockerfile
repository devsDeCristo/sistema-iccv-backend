# syntax=docker/dockerfile:1

# Mesma versão de Node em todos os stages: ABI diferente entre build e runtime
# quebra módulos nativos (bcrypt, sharp).
#
# 22 e não 20: o puppeteer-core, que gera o PDF do quadrante, exige >=22.12 e o
# yarn recusa a instalação inteira por causa disso. É a versão do ambiente de
# desenvolvimento, e a 20 saiu do suporte.
ARG NODE_VERSION=22.20.0

# --------------------------------------------------------------- deps (prod)
# node_modules apenas de produção, compilado com o toolchain disponível.
FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app

# git + ca-certificates: baileys puxa `libsignal` por git+https no lockfile.
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y \
       build-essential node-gyp openssl pkg-config python-is-python3 \
       git ca-certificates \
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
       git ca-certificates \
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

# Menos memória presa por fragmentação. O sharp (que reduz as fotos dos PDFs)
# decodifica imagens grandes em várias threads, e o alocador da glibc abre uma
# arena por thread e não devolve o que sobra: o processo crescia e não
# encolhia. Com 2 arenas, medido reduzindo as 316 fotos do quadrante: o Node
# retém 362 MiB, contra 540 MiB no padrão (e 387 MiB com jemalloc), no mesmo
# tempo. É a saída que a documentação do sharp indica para Linux com glibc.
ENV MALLOC_ARENA_MAX=2

# chromium-headless-shell: o Chromium feito só para automação, usado pelo
# puppeteer-core para gerar os PDFs (quadrante, crachás) a partir de HTML. É o
# mesmo motor de desenho do `chromium` (mesma versão no Debian), sem o código de
# navegador de verdade: medido com o quadrante de 316 pessoas, 47% menos memória
# e mais rápido, com o PDF igual. Instalado via apt (não pelo puppeteer) para
# não baixar outro Chromium na imagem. O `src/pdf/navegador.ts` liga o modo
# `headless: 'shell'` quando o executável é este.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/lib/chromium/chromium-headless-shell

# openssl é exigido pelo query engine do Prisma.
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y openssl chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json yarn.lock ./

# prisma/ precisa existir em runtime: o start.sh roda `prisma migrate deploy`.
COPY prisma ./prisma

# mail.service.ts monta o path dos templates com process.cwd()/src/mail/templates,
# então a pasta de origem tem que existir na imagem — não só o dist.
COPY src/mail/templates ./src/mail/templates

# artes fixas do crachá, lidas do mesmo jeito (process.cwd()/src/...)
COPY src/cracha/assets ./src/cracha/assets

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
