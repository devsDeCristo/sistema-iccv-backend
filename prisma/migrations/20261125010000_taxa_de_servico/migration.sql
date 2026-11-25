-- A taxa de serviço repassada ao inscrito, já somada no valor cobrado do
-- checkout. Zero nos checkouts sem repasse — e em todos os anteriores a ela.
ALTER TABLE "payment_checkouts" ADD COLUMN "serviceFeeCents" INTEGER NOT NULL DEFAULT 0;
