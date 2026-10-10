-- Login pelo Google: e-mail único, contas vinculadas e o método no registro
-- de entrada.

-- O e-mail passa a ser guardado em minúsculas e sem espaço nas pontas
-- (`normalizarEmail`). Os que já existem entram no mesmo formato antes do
-- índice único, senão "Fulano@" e "fulano@" passariam como e-mails diferentes.
UPDATE "users" SET "email" = lower(trim("email")) WHERE "email" <> lower(trim("email"));

-- E-mail repetido nunca foi regra, só falha. Se sobrou algum, a migração para
-- aqui listando quais — o índice falharia do mesmo jeito, só que sem dizer
-- quem. Resolva os cadastros à mão e rode de novo.
DO $$
DECLARE repetidos TEXT;
BEGIN
  SELECT string_agg("email" || ' (' || quantos || 'x)', ', ')
    INTO repetidos
    FROM (
      SELECT "email", count(*) AS quantos
        FROM "users"
       GROUP BY "email"
      HAVING count(*) > 1
    ) AS r;

  IF repetidos IS NOT NULL THEN
    RAISE EXCEPTION 'E-mails repetidos em users, resolva antes de migrar: %', repetidos;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateEnum
CREATE TYPE "LoginMethod" AS ENUM ('PASSWORD', 'GOOGLE');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE');

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
