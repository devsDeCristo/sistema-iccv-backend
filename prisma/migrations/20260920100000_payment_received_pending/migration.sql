-- AlterEnum
-- O estado de nascença da cobrança: nem sistema, nem lançamento manual.
--
-- Sozinho numa migration porque o Postgres recusa usar um valor de enum recém
-- criado na mesma transação em que ele nasce. O default e o acerto das linhas
-- antigas vêm na migration seguinte.
ALTER TYPE "PaymentReceived" ADD VALUE 'PENDING' BEFORE 'SYSTEM';
