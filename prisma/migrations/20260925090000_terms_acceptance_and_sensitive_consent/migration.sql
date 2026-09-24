-- AlterTable
--
-- Saúde passa a aceitar "não informado" (nulo): sem consentimento específico
-- o dado não pode ser guardado, e gravar `false` no lugar faria a organização
-- ler que a pessoa não tem a condição.
--
-- Nenhum dado existente é apagado aqui. Quem já tem cadastro decide, no
-- próximo acesso, se autoriza o tratamento ou se os dados são apagados — a
-- decisão é do titular, não da migração.
ALTER TABLE "users" ALTER COLUMN "diabetes" DROP NOT NULL,
ALTER COLUMN "hypertensive" DROP NOT NULL,
ADD COLUMN     "sensitiveConsentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "terms_acceptances_userId_version_key" ON "terms_acceptances"("userId", "version");

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
