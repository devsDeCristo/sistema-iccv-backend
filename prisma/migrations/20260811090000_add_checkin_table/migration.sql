-- CreateEnum
CREATE TYPE "CheckinStatus" AS ENUM ('PENDING', 'QUEUED', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "checkins" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "CheckinStatus" NOT NULL DEFAULT 'PENDING',
    "badgeDeliveredAt" TIMESTAMP(3),
    "badgeDeliveredById" TEXT,
    "calledAt" TIMESTAMP(3),
    "calledById" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkins_eventId_status_idx" ON "checkins"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "checkins_userId_eventId_key" ON "checkins"("userId", "eventId");

-- AddForeignKey
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
