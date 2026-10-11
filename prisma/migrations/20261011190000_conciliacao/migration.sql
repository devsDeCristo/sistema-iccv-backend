-- AlterTable
ALTER TABLE "financial_entries" ADD COLUMN     "reconciledAt" TIMESTAMP(3),
ADD COLUMN     "reconciledById" TEXT,
ADD COLUMN     "reconciledWithId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "financial_entries_reconciledWithId_key" ON "financial_entries"("reconciledWithId");

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_reconciledWithId_fkey" FOREIGN KEY ("reconciledWithId") REFERENCES "financial_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

