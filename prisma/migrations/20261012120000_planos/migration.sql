-- Planos: quais módulos cada igreja usa.
--
-- Igreja sem plano não tem módulo nenhum. Membros não é módulo: toda igreja tem. Nenhuma igreja nasce com plano: até
-- o super admin escolher um para cada, todas ficam só com o painel básico.
--
-- A cobrança online (`churches.modulePayment`) vira o módulo ONLINE_PAYMENTS do
-- plano; a coluna sai.

-- CreateEnum
CREATE TYPE "ChurchModule" AS ENUM ('EVENTS', 'NEWS', 'TREASURY', 'WHATSAPP', 'INTEGRATIONS', 'ONLINE_PAYMENTS');

-- AlterTable
ALTER TABLE "churches" DROP COLUMN "modulePayment",
ADD COLUMN     "planId" TEXT;

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "modules" "ChurchModule"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- AddForeignKey
ALTER TABLE "churches" ADD CONSTRAINT "churches_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
