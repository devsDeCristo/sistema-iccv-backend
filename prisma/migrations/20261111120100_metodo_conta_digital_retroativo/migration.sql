-- Os pagamentos que já entraram pelo gateway e ficaram como OTHER, corrigidos
-- pelo que o próprio gateway informou na baixa (guardado em
-- payload.payment_method.type). Migração separada da que cria o WALLET: o
-- Postgres não deixa usar um valor de enum na mesma transação que o criou.
--
-- Só linhas cuja origem é o gateway (receivedFrom = SYSTEM): o que alguém
-- lançou à mão no painel fica como foi lançado.

-- conta PayPal; saldo, Linha de Crédito e carteiras do Mercado Pago
UPDATE "payments"
SET "method" = 'WALLET'
WHERE "method" = 'OTHER'
  AND "receivedFrom" = 'SYSTEM'
  AND "payload" -> 'payment_method' ->> 'type' IN
    ('paypal', 'venmo', 'account_money', 'digital_currency', 'digital_wallet');

-- cartão pré-pago do Mercado Pago
UPDATE "payments"
SET "method" = 'DEBIT_CARD'
WHERE "method" = 'OTHER'
  AND "receivedFrom" = 'SYSTEM'
  AND "payload" -> 'payment_method' ->> 'type' = 'prepaid_card';

-- cartão de loja e dinheiro na Ton
UPDATE "payments"
SET "method" = 'CREDIT_CARD'
WHERE "method" = 'OTHER'
  AND "receivedFrom" = 'SYSTEM'
  AND "payload" -> 'payment_method' ->> 'type' = 'private_label';

UPDATE "payments"
SET "method" = 'CASH'
WHERE "method" = 'OTHER'
  AND "receivedFrom" = 'SYSTEM'
  AND "payload" -> 'payment_method' ->> 'type' = 'cash';
