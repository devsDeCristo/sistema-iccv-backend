-- Pix pago na nossa tela (PayPal): o copia e cola que o gateway devolveu e a
-- validade dele. A tela do QR lê daqui, nunca da URL. Nulos nos checkouts por
-- link, que são todos os outros.
ALTER TABLE "payment_checkouts"
  ADD COLUMN "pixCode" TEXT,
  ADD COLUMN "pixExpiresAt" TIMESTAMP(3);
