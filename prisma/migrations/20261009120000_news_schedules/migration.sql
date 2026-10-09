-- Agendamento de disparo de notícia no WhatsApp (uma vez ou toda semana) e
-- histórico dos disparos feitos, para o calendário da tela de notícias.

-- CreateEnum
CREATE TYPE "NewsScheduleKind" AS ENUM ('ONCE', 'WEEKLY');

-- CreateEnum
CREATE TYPE "NewsDispatchOrigin" AS ENUM ('PUBLISH', 'MANUAL', 'SCHEDULE');

-- CreateTable
CREATE TABLE "news_schedules" (
    "id" TEXT NOT NULL,
    "newsId" TEXT NOT NULL,
    "kind" "NewsScheduleKind" NOT NULL,
    "runAt" TIMESTAMP(3),
    "weekdays" INTEGER[],
    "time" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_dispatches" (
    "id" TEXT NOT NULL,
    "newsId" TEXT NOT NULL,
    "origin" "NewsDispatchOrigin" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "noLink" INTEGER NOT NULL,

    CONSTRAINT "news_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "news_schedules_nextRunAt_idx" ON "news_schedules"("nextRunAt");

-- CreateIndex
CREATE INDEX "news_schedules_newsId_idx" ON "news_schedules"("newsId");

-- CreateIndex
CREATE INDEX "news_dispatches_at_idx" ON "news_dispatches"("at");

-- CreateIndex
CREATE INDEX "news_dispatches_newsId_idx" ON "news_dispatches"("newsId");

-- AddForeignKey
ALTER TABLE "news_schedules" ADD CONSTRAINT "news_schedules_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_dispatches" ADD CONSTRAINT "news_dispatches_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "news"("id") ON DELETE CASCADE ON UPDATE CASCADE;

