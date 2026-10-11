-- CreateEnum
CREATE TYPE "FinancialEntryType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "FinancialEntrySource" AS ENUM ('MANUAL', 'PLUGGY');

-- CreateEnum
CREATE TYPE "FinancialMethod" AS ENUM ('PIX', 'CASH', 'CARD', 'TRANSFER', 'BOLETO', 'OTHER');

-- CreateEnum
CREATE TYPE "FinancialCategory" AS ENUM ('TITHE', 'OFFERING', 'DONATION', 'EVENT_INCOME', 'OTHER_INCOME', 'UTILITIES', 'RENT', 'MAINTENANCE', 'SALARIES', 'SUPPLIES', 'MISSIONS', 'EVENT_EXPENSE', 'BANK_FEES', 'OTHER_EXPENSE');

-- CreateTable
CREATE TABLE "tithers" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "since" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "tithers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_entries" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "type" "FinancialEntryType" NOT NULL,
    "category" "FinancialCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "method" "FinancialMethod",
    "userId" TEXT,
    "source" "FinancialEntrySource" NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "bankAccount" TEXT,
    "payerName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tithers_churchId_userId_key" ON "tithers"("churchId", "userId");

-- CreateIndex
CREATE INDEX "financial_entries_churchId_date_idx" ON "financial_entries"("churchId", "date");

-- CreateIndex
CREATE INDEX "financial_entries_userId_idx" ON "financial_entries"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "financial_entries_churchId_externalId_key" ON "financial_entries"("churchId", "externalId");

-- AddForeignKey
ALTER TABLE "tithers" ADD CONSTRAINT "tithers_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tithers" ADD CONSTRAINT "tithers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

