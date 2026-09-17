-- Produtos vendidos na inscrição do evento (camisa, caneca), com variantes
-- (tamanho, cor) e os itens comprados, pendurados no pagamento do ingresso.
--
-- O preço mora no produto, não na variante. O estoque mora na variante e é
-- opcional; o vendido não tem coluna: é a soma dos itens de pagamentos que
-- ainda valem, para que cancelar, estornar ou remover a inscrição devolva a
-- unidade sozinho.
--
-- `unitPrice` guarda o preço do momento da compra: o admin pode mudar o preço
-- do produto depois, e o que a pessoa escolheu pagar não muda junto.

CREATE TABLE "event_products" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_product_variants" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stock" INTEGER,

    CONSTRAINT "event_product_variants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_product_items" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_product_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "event_products_eventId_idx" ON "event_products"("eventId");
CREATE INDEX "event_product_variants_productId_idx" ON "event_product_variants"("productId");
CREATE UNIQUE INDEX "payment_product_items_paymentId_variantId_key" ON "payment_product_items"("paymentId", "variantId");
CREATE INDEX "payment_product_items_variantId_idx" ON "payment_product_items"("variantId");

ALTER TABLE "event_products" ADD CONSTRAINT "event_products_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_product_variants" ADD CONSTRAINT "event_product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "event_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_product_items" ADD CONSTRAINT "payment_product_items_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_product_items" ADD CONSTRAINT "payment_product_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "event_product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
