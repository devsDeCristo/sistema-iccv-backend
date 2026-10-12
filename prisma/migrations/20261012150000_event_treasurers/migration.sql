-- Tesoureiro(a) de evento: o vínculo de quem cuida da tesouraria de um evento
-- sem ser admin nem tesouraria da igreja. Só cria a tabela; nada é copiado.
-- CreateEnum
CREATE TYPE "EventTreasurerKind" AS ENUM ('BASICO', 'COMPLETO');

-- CreateTable
CREATE TABLE "event_treasurers" (
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "EventTreasurerKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "event_treasurers_pkey" PRIMARY KEY ("eventId","userId")
);

-- CreateIndex
CREATE INDEX "event_treasurers_userId_idx" ON "event_treasurers"("userId");

-- AddForeignKey
ALTER TABLE "event_treasurers" ADD CONSTRAINT "event_treasurers_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_treasurers" ADD CONSTRAINT "event_treasurers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

