-- Freio de senha errada: conta as falhas de um documento nas últimas janelas.

-- CreateIndex
CREATE INDEX "login_attempts_document_createdAt_idx" ON "login_attempts"("document", "createdAt" DESC);
