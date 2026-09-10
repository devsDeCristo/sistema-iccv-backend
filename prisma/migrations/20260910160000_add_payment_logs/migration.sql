-- Trilha do dinheiro, separada de `logs`.
--
-- `logs` responde "quem mexeu no sistema" e guarda o registro inteiro em JSON.
-- A pergunta do financeiro é outra — "o que aconteceu com esta cobrança" — e
-- precisa de valor, status e origem na própria linha, sem abrir JSON e sem
-- depender de um join que morre quando a inscrição é cancelada.
--
-- Uma linha por cobrança afetada, e não por comando: o `updateMany` da
-- reconciliação mexe em várias de uma vez.
CREATE TYPE "PaymentLogSource" AS ENUM ('PANEL', 'WEBHOOK', 'CRON', 'SYSTEM');

CREATE TABLE "payment_logs" (
    "id" TEXT NOT NULL,
    -- sem chave estrangeira de propósito: apagar a cobrança não pode levar o
    -- histórico junto, e é justamente aí que ele importa
    "paymentId" TEXT,
    "userId" TEXT,
    "eventId" TEXT,
    "model" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT,
    "amountBefore" DOUBLE PRECISION,
    "amountAfter" DOUBLE PRECISION,
    -- texto e não enum: `payments` usa PaymentStatus e `payment_checkouts` usa
    -- CheckoutStatus, e a mesma coluna guarda os dois
    "statusBefore" TEXT,
    "statusAfter" TEXT,
    "source" "PaymentLogSource" NOT NULL,
    "actorId" TEXT,
    "operation" TEXT,
    "requestId" TEXT,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_logs_paymentId_createdAt_idx" ON "payment_logs"("paymentId", "createdAt" DESC);
CREATE INDEX "payment_logs_eventId_createdAt_idx" ON "payment_logs"("eventId", "createdAt" DESC);
CREATE INDEX "payment_logs_userId_createdAt_idx" ON "payment_logs"("userId", "createdAt" DESC);
CREATE INDEX "payment_logs_createdAt_idx" ON "payment_logs"("createdAt" DESC);
