-- O "Aceitar Pix" do PayPal virou o campo de formas de pagamento
-- (`enabledMethods`), igual ao dos outros gateways.
--
-- Só a dica da tela muda aqui: a credencial é cifrada e o banco não a abre.
-- Enquanto a igreja não salvar o formulário novo, o adapter continua lendo a
-- chave antiga (`pix`) de dentro do cofre; esta linha faz o formulário abrir
-- com o Pix marcado para quem já o tinha ligado, em vez de mostrar só o
-- cartão e desligar o Pix no primeiro salvar.
UPDATE "payment_provider_configs"
SET "credentialsHint" = "credentialsHint" || '{"enabledMethods": "PIX,CREDIT_CARD"}'::jsonb
WHERE "provider" = 'PAYPAL'
  AND "credentialsHint" ->> 'pix' = 'true'
  AND NOT ("credentialsHint" ? 'enabledMethods');
