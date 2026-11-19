CREATE TYPE "PaymentScenario" AS ENUM ('NORMAL', 'DECLINE', 'FAILOVER', 'TIMEOUT_SUCCESS', 'TIMEOUT_UNKNOWN', 'TIMEOUT_FAILOVER');

ALTER TABLE "Transaction"
  ADD COLUMN "scenario" "PaymentScenario" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "nextActionAt" TIMESTAMPTZ(3);

ALTER TABLE "TransactionAttempt"
  ADD COLUMN "verificationCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "responseTimeMs" INTEGER;

ALTER TABLE "WebhookEvent" ADD COLUMN "processingAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SettlementRecord" ADD COLUMN "simulatorGenerated" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Transaction_nextActionAt_idx" ON "Transaction"("nextActionAt");
CREATE UNIQUE INDEX "SettlementRecord_simulator_reference_key" ON "SettlementRecord"("merchantId", "gatewayId", "gatewayReference") WHERE "simulatorGenerated";

INSERT INTO "Gateway" ("id", "code", "name", "successRate", "responseTimeMs", "supportedMethods", "updatedAt")
VALUES
  ('30456b97-9392-4936-9f14-1d9ce76487a1', 'gateway-a', 'Gateway A', 0.9850, 218, ARRAY['CARD', 'UPI', 'BANK_TRANSFER']::"PaymentMethod"[], CURRENT_TIMESTAMP),
  ('30456b97-9392-4936-9f14-1d9ce76487a2', 'gateway-b', 'Gateway B', 0.9600, 162, ARRAY['CARD', 'UPI', 'WALLET']::"PaymentMethod"[], CURRENT_TIMESTAMP),
  ('30456b97-9392-4936-9f14-1d9ce76487a3', 'gateway-c', 'Gateway C', 0.9400, 389, ARRAY['CARD', 'WALLET', 'BANK_TRANSFER']::"PaymentMethod"[], CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
