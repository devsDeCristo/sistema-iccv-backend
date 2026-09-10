-- O que a pessoa mandou o sistema fazer, no molde da rota
-- (`POST /events/:idEvent/users/:idUser`). O `requestId` já amarrava as
-- escritas de uma mesma ação; faltava dizer que ação era ela — até aqui o nome
-- vinha deduzido da tabela mais pesada do grupo, que acerta na inscrição e erra
-- em tudo que mexe nas mesmas tabelas por outro motivo.
--
-- Sem backfill: o histórico não guarda a rota, e inventá-la a partir das
-- tabelas seria repetir a dedução como se fosse fato. Linha antiga fica nula e
-- a tela volta a nomeá-la pela tabela principal.
ALTER TABLE "logs" ADD COLUMN "operation" TEXT;

-- Atende o filtro por operação, que sempre vem com recorte de período
CREATE INDEX "logs_operation_createdAt_idx" ON "logs"("operation", "createdAt" DESC);
