-- Pagamento com saldo ou conta do próprio gateway (conta PayPal; saldo, Linha
-- de Crédito e carteiras do Mercado Pago). Antes ia para OTHER, que também quer
-- dizer "forma ainda não definida".
ALTER TYPE "PaymentMethod" ADD VALUE 'WALLET';
