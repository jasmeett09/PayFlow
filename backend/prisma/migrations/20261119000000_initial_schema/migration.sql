-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MERCHANT');

-- CreateEnum
CREATE TYPE "GatewayHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'UPI', 'BANK_TRANSFER', 'WALLET');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'PENDING', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('STARTED', 'SUCCESS', 'DECLINED', 'RETRYABLE_FAILURE', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "WebhookType" AS ENUM ('PAYMENT_SUCCESSFUL', 'PAYMENT_FAILED', 'PAYMENT_PENDING', 'REFUND_COMPLETED');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('MATCHED', 'DISCREPANCIES', 'FAILED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "routingWeights" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "merchantId" UUID,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MERCHANT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gateway" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "health" "GatewayHealth" NOT NULL DEFAULT 'HEALTHY',
    "successRate" DECIMAL(5,4) NOT NULL,
    "responseTimeMs" INTEGER NOT NULL,
    "supportedMethods" "PaymentMethod"[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantGateway" (
    "merchantId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MerchantGateway_pkey" PRIMARY KEY ("merchantId","gatewayId")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "gatewayId" UUID,
    "merchantReference" VARCHAR(120),
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'CREATED',
    "failureReason" TEXT,
    "gatewayReference" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionAttempt" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'STARTED',
    "gatewayReference" VARCHAR(128),
    "failureReason" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TransactionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingDecision" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "selectedGatewayId" UUID,
    "strategy" VARCHAR(32) NOT NULL,
    "candidates" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "eventId" VARCHAR(128) NOT NULL,
    "merchantId" UUID,
    "transactionId" UUID,
    "type" "WebhookType" NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "deliveryCount" INTEGER NOT NULL DEFAULT 1,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "merchantId" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "transactionId" UUID NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("merchantId","key")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "gatewayReference" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementRecord" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "gatewayReference" VARCHAR(128) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "settledAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationReport" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "mismatched" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "status" "ReconciliationStatus" NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "merchantId" UUID,
    "actorId" UUID,
    "transactionId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_merchantId_idx" ON "User"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Gateway_code_key" ON "Gateway"("code");

-- CreateIndex
CREATE INDEX "MerchantGateway_gatewayId_idx" ON "MerchantGateway"("gatewayId");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_createdAt_id_idx" ON "Transaction"("merchantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_status_createdAt_idx" ON "Transaction"("merchantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_gatewayId_createdAt_idx" ON "Transaction"("merchantId", "gatewayId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_merchantId_id_key" ON "Transaction"("merchantId", "id");

-- CreateIndex
CREATE INDEX "TransactionAttempt_merchantId_gatewayId_startedAt_idx" ON "TransactionAttempt"("merchantId", "gatewayId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAttempt_merchantId_transactionId_sequence_key" ON "TransactionAttempt"("merchantId", "transactionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionAttempt_gatewayId_gatewayReference_key" ON "TransactionAttempt"("gatewayId", "gatewayReference");

-- CreateIndex
CREATE INDEX "RoutingDecision_merchantId_transactionId_createdAt_idx" ON "RoutingDecision"("merchantId", "transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "RoutingDecision_merchantId_createdAt_idx" ON "RoutingDecision"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_merchantId_receivedAt_idx" ON "WebhookEvent"("merchantId", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_merchantId_transactionId_idx" ON "WebhookEvent"("merchantId", "transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_gatewayId_eventId_key" ON "WebhookEvent"("gatewayId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_merchantId_transactionId_key" ON "IdempotencyRecord"("merchantId", "transactionId");

-- CreateIndex
CREATE INDEX "Refund_merchantId_transactionId_createdAt_idx" ON "Refund"("merchantId", "transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementRecord_merchantId_gatewayId_gatewayReference_idx" ON "SettlementRecord"("merchantId", "gatewayId", "gatewayReference");

-- CreateIndex
CREATE INDEX "SettlementRecord_merchantId_settledAt_idx" ON "SettlementRecord"("merchantId", "settledAt");

-- CreateIndex
CREATE INDEX "ReconciliationReport_merchantId_createdAt_idx" ON "ReconciliationReport"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_createdAt_idx" ON "AuditLog"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_merchantId_transactionId_createdAt_idx" ON "AuditLog"("merchantId", "transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantGateway" ADD CONSTRAINT "MerchantGateway_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantGateway" ADD CONSTRAINT "MerchantGateway_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_gatewayId_fkey" FOREIGN KEY ("merchantId", "gatewayId") REFERENCES "MerchantGateway"("merchantId", "gatewayId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_merchantId_transactionId_fkey" FOREIGN KEY ("merchantId", "transactionId") REFERENCES "Transaction"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_merchantId_gatewayId_fkey" FOREIGN KEY ("merchantId", "gatewayId") REFERENCES "MerchantGateway"("merchantId", "gatewayId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_merchantId_transactionId_fkey" FOREIGN KEY ("merchantId", "transactionId") REFERENCES "Transaction"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingDecision" ADD CONSTRAINT "RoutingDecision_merchantId_selectedGatewayId_fkey" FOREIGN KEY ("merchantId", "selectedGatewayId") REFERENCES "MerchantGateway"("merchantId", "gatewayId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_merchantId_transactionId_fkey" FOREIGN KEY ("merchantId", "transactionId") REFERENCES "Transaction"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_merchantId_transactionId_fkey" FOREIGN KEY ("merchantId", "transactionId") REFERENCES "Transaction"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_merchantId_transactionId_fkey" FOREIGN KEY ("merchantId", "transactionId") REFERENCES "Transaction"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRecord" ADD CONSTRAINT "SettlementRecord_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRecord" ADD CONSTRAINT "SettlementRecord_merchantId_gatewayId_fkey" FOREIGN KEY ("merchantId", "gatewayId") REFERENCES "MerchantGateway"("merchantId", "gatewayId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationReport" ADD CONSTRAINT "ReconciliationReport_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_merchantId_transactionId_fkey" FOREIGN KEY ("merchantId", "transactionId") REFERENCES "Transaction"("merchantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariants managed in SQL because Prisma models do not express CHECK constraints.
ALTER TABLE "User" ADD CONSTRAINT "User_role_merchant_check" CHECK (
  ("role" = 'ADMIN' AND "merchantId" IS NULL) OR
  ("role" = 'MERCHANT' AND "merchantId" IS NOT NULL)
);

ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_metrics_check" CHECK (
  "successRate" BETWEEN 0 AND 1 AND "responseTimeMs" >= 0 AND COALESCE(cardinality("supportedMethods"), 0) > 0
);

ALTER TABLE "MerchantGateway" ADD CONSTRAINT "MerchantGateway_priority_check" CHECK ("priority" >= 0);

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_amount_currency_check" CHECK (
  "amountMinor" > 0 AND "currency" ~ '^[A-Z]{3}$'
);

ALTER TABLE "TransactionAttempt" ADD CONSTRAINT "TransactionAttempt_order_check" CHECK (
  "sequence" > 0 AND ("completedAt" IS NULL OR "completedAt" >= "startedAt")
);

ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_delivery_check" CHECK (
  "deliveryCount" > 0 AND (("merchantId" IS NULL) = ("transactionId" IS NULL))
);

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_fingerprint_check" CHECK (
  "requestHash" ~ '^[0-9a-f]{64}$' AND ("responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599)
);

ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amountMinor" > 0);

ALTER TABLE "SettlementRecord" ADD CONSTRAINT "SettlementRecord_amount_currency_check" CHECK (
  "amountMinor" > 0 AND "currency" ~ '^[A-Z]{3}$'
);

ALTER TABLE "ReconciliationReport" ADD CONSTRAINT "ReconciliationReport_window_counts_check" CHECK (
  "periodEnd" > "periodStart" AND
  LEAST("checked", "matched", "mismatched", "missing", "duplicates") >= 0
);

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_transaction_scope_check" CHECK (
  "transactionId" IS NULL OR "merchantId" IS NOT NULL
);
