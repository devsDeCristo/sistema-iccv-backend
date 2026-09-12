-- Credenciais de cobrança por igreja.
--
-- Até aqui o sistema cobrava por um token só, guardado no `.env`: valia para o
-- servidor inteiro, então duas igrejas no mesmo deploy recebiam na conta da
-- primeira, e trocar de gateway era mexer em variável de ambiente e subir de
-- novo. Esta tabela move a decisão para o banco e para o tenant — cada igreja
-- escolhe a casa, guarda a credencial dela, e o dinheiro do evento dela cai lá.
--
-- A credencial nunca entra aqui em claro: `credentials` recebe um envelope
-- AES-256-GCM selado com `churchId` e `provider` como dado autenticado (ver
-- `SecretCryptoService`). Copiar o envelope da igreja A para a linha da igreja
-- B não funciona: o selo não confere e a abertura falha.

CREATE TYPE "PaymentProvider" AS ENUM ('PAGBANK', 'MERCADO_PAGO', 'INFINITEPAY', 'TON');

CREATE TYPE "PaymentProviderMode" AS ENUM ('SANDBOX', 'PRODUCTION');

CREATE TABLE "payment_provider_configs" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "mode" "PaymentProviderMode" NOT NULL DEFAULT 'PRODUCTION',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "credentials" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "credentialsHint" JSONB,
    "webhookSecretHash" TEXT NOT NULL,
    "webhookSecretHint" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "payment_provider_configs_pkey" PRIMARY KEY ("id")
);

-- A URL de notificação carrega o segredo, e a rota encontra a configuração pelo
-- hash dele. O índice único é o que faz essa busca ser por chave — e garante
-- que dois segredos nunca colidam entre igrejas.
CREATE UNIQUE INDEX "payment_provider_configs_webhookSecretHash_key"
  ON "payment_provider_configs"("webhookSecretHash");

-- Uma linha por casa em cada igreja: a mesma cadastrada duas vezes só cria
-- dúvida sobre qual credencial está valendo.
CREATE UNIQUE INDEX "payment_provider_configs_churchId_provider_key"
  ON "payment_provider_configs"("churchId", "provider");

CREATE INDEX "payment_provider_configs_churchId_idx"
  ON "payment_provider_configs"("churchId");

-- Cascade porque a credencial não existe fora da igreja: apagada a igreja, não
-- há a quem a chave sirva. A igreja só é apagada quando já não tem evento nem
-- administrador (ver `ChurchService.remove`), então não há cobrança em curso.
ALTER TABLE "payment_provider_configs"
  ADD CONSTRAINT "payment_provider_configs_churchId_fkey"
  FOREIGN KEY ("churchId") REFERENCES "churches"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- De quem é cada checkout.
--
-- Com um gateway só, a pergunta não existia. Com quatro, o `referenceId`
-- sozinho não diz a quem perguntar pelo status — e perguntar à casa errada
-- devolve "não existe": a reconciliação desistiria da cobrança e um pagamento
-- já pago ficaria em WAITING para sempre.
--
-- O default 'PAGBANK' é o backfill: toda linha anterior a esta coluna nasceu
-- lá, então o valor é fato e não chute.
ALTER TABLE "payment_checkouts"
  ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'PAGBANK';

-- Sem FK e sem cascade: remover a credencial não pode levar junto o histórico
-- do checkout que ela gerou.
ALTER TABLE "payment_checkouts" ADD COLUMN "configId" TEXT;

-- Atende o webhook e a reconciliação, que chegam pelo par referência + casa
CREATE INDEX "payment_checkouts_provider_referenceId_idx"
  ON "payment_checkouts"("provider", "referenceId");
