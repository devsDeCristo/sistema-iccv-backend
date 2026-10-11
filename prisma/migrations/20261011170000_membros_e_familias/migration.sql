-- AlterTable
ALTER TABLE "users" ADD COLUMN     "familyId" TEXT,
ADD COLUMN     "memberChurchId" TEXT,
ADD COLUMN     "memberSince" TIMESTAMP(3),
ADD COLUMN     "otherChurchName" TEXT,
ADD COLUMN     "requestedChurchId" TEXT;

-- CreateTable
CREATE TABLE "families" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "families_churchId_idx" ON "families"("churchId");

-- CreateIndex
CREATE INDEX "users_memberChurchId_idx" ON "users"("memberChurchId");

-- CreateIndex
CREATE INDEX "users_requestedChurchId_idx" ON "users"("requestedChurchId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_memberChurchId_fkey" FOREIGN KEY ("memberChurchId") REFERENCES "churches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_requestedChurchId_fkey" FOREIGN KEY ("requestedChurchId") REFERENCES "churches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

