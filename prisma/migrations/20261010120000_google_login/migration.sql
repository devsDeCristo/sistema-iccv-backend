-- Login pelo Google: e-mail único, contas vinculadas e o método no registro
-- de entrada.

-- O e-mail passa a ser guardado em minúsculas e sem espaço nas pontas
-- (`normalizarEmail`). Os que já existem entram no mesmo formato, para a busca
-- por e-mail (login com Google, checagem de repetido) achar todos.
UPDATE "users" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));

-- Sem índice único por enquanto: há e-mails repetidos em produção, de antes da
-- regra. Quem barra repetido novo é o código (`UserService.emailEmUso`); o
-- índice comum só atende a busca.
-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateEnum
CREATE TYPE "LoginMethod" AS ENUM ('PASSWORD', 'GOOGLE');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE');

-- AlterTable
-- o vínculo do Google pelo perfil guarda a conta escolhida até o código voltar
ALTER TABLE "user_tokens" ADD COLUMN     "payload" JSONB;

-- AlterTable
ALTER TABLE "login_attempts" ADD COLUMN     "method" "LoginMethod" NOT NULL DEFAULT 'PASSWORD';

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_userId_provider_key" ON "user_identities"("userId", "provider");

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
