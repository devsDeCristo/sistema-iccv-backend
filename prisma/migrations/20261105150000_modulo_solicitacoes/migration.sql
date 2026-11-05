-- CreateEnum
CREATE TYPE "ChurchRequestStatus" AS ENUM ('REQUESTED', 'IN_REVIEW', 'REJECTED', 'ACCEPTED');

-- AlterEnum
ALTER TYPE "ChurchModule" ADD VALUE 'REQUESTS';

-- CreateTable
CREATE TABLE "church_requests" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "ministry" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ChurchRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "church_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "church_requests_churchId_createdAt_idx" ON "church_requests"("churchId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "church_requests_requesterId_createdAt_idx" ON "church_requests"("requesterId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "church_requests" ADD CONSTRAINT "church_requests_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "churches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "church_requests" ADD CONSTRAINT "church_requests_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

