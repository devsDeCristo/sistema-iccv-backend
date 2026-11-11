-- Por qual gateway o dinheiro entrou, na própria cobrança: é o que a auditoria
-- confere contra o extrato de cada gateway. Até aqui só o checkout sabia, e uma
-- cobrança pode ter checkouts de gateways diferentes (a igreja trocou de
-- gateway no meio).
ALTER TABLE "payments" ADD COLUMN "provider" "PaymentProvider";

-- Retroativo, só para o que entrou pelo gateway (receivedFrom = SYSTEM): o
-- gateway do checkout mais recente da cobrança. É o que o confirmou — a baixa
-- fecha o checkout e um checkout novo invalida os anteriores —, e na prática
-- toda cobrança antiga é do PagBank.
UPDATE "payments" AS p
SET "provider" = (
  SELECT c."provider"
  FROM "payment_checkouts" AS c
  WHERE c."paymentId" = p."id"
  ORDER BY c."createdAt" DESC
  LIMIT 1
)
WHERE p."receivedFrom" = 'SYSTEM';
