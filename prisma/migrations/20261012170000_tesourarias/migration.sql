-- Tesourarias de evento e de congregação, com o extrato distribuído entre elas.
--
-- - A Pluggy guarda a divisão dos bancos por tesouraria (`splitByTreasury`,
--   `itemAccounts`); cada movimento guarda a conta (`account`) e o banco
--   (`bankItemId`) de onde veio. O que já foi importado nasce da
--   Administrativa, que era tudo o que existia.
-- - `treasuries`, `treasury_allocations` (o rateio do extrato),
--   `treasury_entries` (o lançamento manual do evento) e
--   `treasury_payment_links` (o pagamento do evento diante do extrato).
-- Nada existente muda de valor.

-- CreateEnum
CREATE TYPE "TreasuryAccount" AS ENUM ('ADMINISTRATIVE', 'EVENTS', 'CONGREGATIONS');

-- CreateEnum
CREATE TYPE "TreasuryKind" AS ENUM ('EVENT', 'CONGREGATION');

-- AlterTable
ALTER TABLE "pluggy_integrations" ADD COLUMN     "itemAccounts" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "splitByTreasury" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "financial_entries" ADD COLUMN     "account" "TreasuryAccount" NOT NULL DEFAULT 'ADMINISTRATIVE',
ADD COLUMN     "bankItemId" TEXT;

-- CreateTable
CREATE TABLE "treasuries" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "kind" "TreasuryKind" NOT NULL,
    "eventId" TEXT,
    "name" TEXT,
    "date" DATE,
    "location" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "treasuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_allocations" (
    "id" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "treasury_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_entries" (
    "id" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "type" "FinancialEntryType" NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "date" DATE NOT NULL,
    "method" "FinancialMethod",
    "movementId" TEXT,
    "notInBankAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "treasury_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_payment_links" (
    "paymentId" TEXT NOT NULL,
    "treasuryId" TEXT NOT NULL,
    "movementId" TEXT,
    "notInBankAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treasury_payment_links_pkey" PRIMARY KEY ("paymentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasuries_eventId_key" ON "treasuries"("eventId");

-- CreateIndex
CREATE INDEX "treasuries_churchId_kind_idx" ON "treasuries"("churchId", "kind");

-- CreateIndex
CREATE INDEX "treasury_allocations_entryId_idx" ON "treasury_allocations"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "treasury_allocations_treasuryId_entryId_key" ON "treasury_allocations"("treasuryId", "entryId");

-- CreateIndex
CREATE INDEX "treasury_entries_treasuryId_idx" ON "treasury_entries"("treasuryId");

-- CreateIndex
CREATE INDEX "treasury_payment_links_treasuryId_idx" ON "treasury_payment_links"("treasuryId");

-- CreateIndex
CREATE INDEX "financial_entries_churchId_account_date_idx" ON "financial_entries"("churchId", "account", "date");

-- AddForeignKey
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_allocations" ADD CONSTRAINT "treasury_allocations_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "treasuries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_allocations" ADD CONSTRAINT "treasury_allocations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "financial_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_entries" ADD CONSTRAINT "treasury_entries_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "treasuries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_entries" ADD CONSTRAINT "treasury_entries_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "financial_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_payment_links" ADD CONSTRAINT "treasury_payment_links_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_payment_links" ADD CONSTRAINT "treasury_payment_links_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "treasuries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treasury_payment_links" ADD CONSTRAINT "treasury_payment_links_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "financial_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

