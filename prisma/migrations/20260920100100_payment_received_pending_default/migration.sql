-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "receivedFrom" SET DEFAULT 'PENDING';

-- Toda cobrança nascia marcada como SYSTEM, inclusive a que nunca passou por
-- gateway nenhum — e era isso que deixava a tela de detalhes bloqueada em
-- pagamento que só pode ser resolvido à mão.
--
-- O que separa uma da outra é o payload: o retorno do gateway (webhook ou
-- reconciliação) grava ali método, código da transação e comprovante. Linha
-- sem payload nunca recebeu dado de gateway nenhum.
UPDATE "payments"
SET "receivedFrom" = 'PENDING'
WHERE "receivedFrom" = 'SYSTEM'
  AND ("payload" IS NULL OR "payload"::text IN ('{}', 'null'));
