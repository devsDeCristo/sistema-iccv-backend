-- AlterTable
-- Aceite do termo do evento, marcado na tela de inscrição. Nulo nas inscrições
-- que já existem: foram feitas quando ainda não havia termo.
ALTER TABLE "EventOnUsers" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3);
