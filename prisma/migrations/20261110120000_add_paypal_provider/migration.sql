-- PayPal como gateway. Só o valor novo do enum: a credencial mora no mesmo
-- envelope cifrado de `payment_provider_configs`, e nada mais muda de forma.
ALTER TYPE "PaymentProvider" ADD VALUE 'PAYPAL';
