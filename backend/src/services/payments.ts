import { createHash } from 'node:crypto';
import { Prisma, type PaymentMethod, type PaymentScenario, type PrismaClient, type Transaction, type TransactionStatus } from '@prisma/client';
import { gatewayAdapter } from '../adapters/simulator.js';
import { lockRecord, publicPayment, type Database } from '../repositories/payments.js';
import { ApiError } from '../utils/api-error.js';
import { routePayment } from './routing.js';

const transitions: Record<TransactionStatus, TransactionStatus[]> = {
  CREATED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SUCCESS', 'FAILED', 'PENDING', 'CANCELLED'],
  PENDING: ['PROCESSING', 'SUCCESS', 'FAILED'],
  SUCCESS: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
};

type PaymentInput = {
  amountMinor: string;
  currency: string;
  paymentMethod: PaymentMethod;
  merchantReference?: string;
  scenario: PaymentScenario;
};

export const defaultRetryPolicy = { maxAttempts: 3, maxVerifications: 4, baseDelayMs: 750 };
export type RetryPolicy = typeof defaultRetryPolicy;

export function canTransition(from: TransactionStatus, to: TransactionStatus) {
  return transitions[from].includes(to);
}

export async function transition(db: Database, payment: Transaction, to: TransactionStatus,
  changes: Prisma.TransactionUncheckedUpdateInput = {}, actorId?: string) {
  if (!canTransition(payment.status, to)) {
    throw new ApiError(409, 'INVALID_TRANSITION', `Cannot move payment from ${payment.status} to ${to}`);
  }
  const updated = await db.transaction.update({
    where: { id: payment.id },
    data: { nextActionAt: null, ...changes, status: to },
  });
  await db.auditLog.create({
    data: {
      merchantId: payment.merchantId,
      transactionId: payment.id,
      actorId,
      action: 'PAYMENT_STATUS_CHANGED',
      metadata: { from: payment.status, to, reason: updated.failureReason },
    },
  });
  return updated;
}

export async function settlePayment(db: Database, payment: Transaction, status: 'SUCCESS' | 'REFUNDED') {
  const { merchantId, gatewayId, gatewayReference, amountMinor, currency } = payment;
  if (!gatewayId || !gatewayReference) throw new Error('Payment settlement has no gateway reference');
  if (status === 'REFUNDED') {
    await db.settlementRecord.updateMany({
      where: { merchantId, gatewayId, gatewayReference, simulatorGenerated: true },
      data: { status },
    });
    return;
  }
  await db.settlementRecord.create({
    data: { merchantId, gatewayId, gatewayReference, amountMinor, currency, status, settledAt: new Date(), simulatorGenerated: true },
  });
}

export async function refundPayment(db: Database, payment: Transaction, actorId?: string) {
  if (payment.status === 'REFUNDED') return payment;
  if (payment.status !== 'SUCCESS' || !payment.gatewayReference || !payment.gatewayId) {
    throw new ApiError(409, 'INVALID_TRANSITION', 'Only successful payments can be refunded');
  }
  const gateway = await db.gateway.findUniqueOrThrow({ where: { id: payment.gatewayId } });
  await db.refund.create({
    data: {
      merchantId: payment.merchantId, transactionId: payment.id, amountMinor: payment.amountMinor,
      status: 'SUCCESS', gatewayReference: gatewayAdapter(gateway.code).refund(payment.gatewayReference),
    },
  });
  const updated = await transition(db, payment, 'REFUNDED', {}, actorId);
  await settlePayment(db, updated, 'REFUNDED');
  return updated;
}

export function createPaymentService(db: PrismaClient, policy: RetryPolicy = defaultRetryPolicy) {
  function nextAction(exponent: number) {
    return new Date(Date.now() + policy.baseDelayMs * 2 ** Math.min(exponent, 8));
  }

  async function create(merchantId: string, actorId: string, key: string, input: PaymentInput) {
    const requestHash = createHash('sha256').update(JSON.stringify([
      input.amountMinor, input.currency, input.paymentMethod, input.merchantReference ?? null, input.scenario,
    ])).digest('hex');
    const where = { merchantId_key: { merchantId, key } };
    return db.$transaction(async tx => {
      await lockRecord(tx, 'idempotency', JSON.stringify([merchantId, key]));
      const existing = await tx.idempotencyRecord.findUnique({ where });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key already represents a different payment');
        }
        return { status: existing.responseStatus!, body: existing.responseBody, replayed: true };
      }

      const payment = await tx.transaction.create({
        data: { ...input, merchantId, amountMinor: BigInt(input.amountMinor), nextActionAt: new Date() },
      });
      const body = { data: { ...publicPayment(payment), createdAt: payment.createdAt.toISOString(), updatedAt: payment.updatedAt.toISOString() } };
      await tx.idempotencyRecord.create({
        data: { merchantId, key, requestHash, transactionId: payment.id, responseStatus: 202, responseBody: body },
      });
      await tx.auditLog.create({
        data: { merchantId, transactionId: payment.id, actorId, action: 'PAYMENT_CREATED', metadata: { to: 'CREATED' } },
      });
      return { status: 202, body, replayed: false };
    });
  }

  async function process(id: string) {
    await db.$transaction(async tx => {
      await lockRecord(tx, 'payment', id);
      let payment = await tx.transaction.findUnique({ where: { id } });
      if (!payment?.nextActionAt || payment.nextActionAt > new Date()) return;

      const attempts = await tx.transactionAttempt.findMany({
        where: { merchantId: payment.merchantId, transactionId: id },
        orderBy: { sequence: 'asc' },
      });
      const last = attempts.at(-1);
      if (payment.status === 'PENDING') {
        if (last?.status !== 'UNCERTAIN') throw new Error('Pending payment has no uncertain attempt');
        const gateway = await tx.gateway.findUniqueOrThrow({ where: { id: last.gatewayId } });
        const verificationCount = last.verificationCount + 1;
        const outcome = gatewayAdapter(gateway.code).check({
          paymentId: id, sequence: last.sequence, scenario: payment.scenario,
          baselineSuccessRate: Number(gateway.successRate), baselineResponseTimeMs: gateway.responseTimeMs,
        }, verificationCount);
        await tx.auditLog.create({
          data: { merchantId: payment.merchantId, transactionId: id, action: 'GATEWAY_STATUS_CHECKED',
            metadata: { gateway: gateway.code, verificationCount, outcome } },
        });
        await tx.transactionAttempt.update({
          where: { id: last.id },
          data: {
            verificationCount,
            ...(outcome === 'UNKNOWN' ? {} : {
              status: outcome === 'SUCCESS' ? 'SUCCESS' : 'RETRYABLE_FAILURE',
              completedAt: new Date(Math.max(Date.now(), Number(last.startedAt))),
              failureReason: outcome === 'SUCCESS' ? null : 'Gateway confirmed no charge',
            }),
          },
        });
        if (outcome === 'SUCCESS') {
          const paid = await transition(tx, payment, 'SUCCESS', { failureReason: null });
          await settlePayment(tx, paid, 'SUCCESS');
        } else if (outcome === 'UNAVAILABLE') {
          await transition(tx, payment, last.sequence < policy.maxAttempts ? 'PROCESSING' : 'FAILED', {
            failureReason: 'Gateway confirmed no charge',
            nextActionAt: last.sequence < policy.maxAttempts ? nextAction(last.sequence - 1) : null,
          });
        } else {
          await tx.transaction.update({ where: { id }, data: {
            nextActionAt: verificationCount < policy.maxVerifications ? nextAction(verificationCount) : null,
            failureReason: verificationCount < policy.maxVerifications ? 'Gateway outcome remains unknown' : 'Awaiting a definitive gateway webhook',
          } });
        }
        return;
      }

      if (payment.status === 'CREATED') payment = await transition(tx, payment, 'PROCESSING');
      if (payment.status !== 'PROCESSING') return;
      const decision = await routePayment(tx, payment.merchantId, payment.paymentMethod, attempts.map(attempt => attempt.gatewayId));
      await tx.routingDecision.create({
        data: { transactionId: id, merchantId: payment.merchantId, ...decision },
      });
      if (!decision.selectedGatewayId) {
        await transition(tx, payment, 'FAILED', { failureReason: decision.reason });
        return;
      }

      const gateway = await tx.gateway.findUniqueOrThrow({ where: { id: decision.selectedGatewayId } });
      const sequence = attempts.length + 1;
      const startedAt = new Date();
      const result = gatewayAdapter(gateway.code).initiate({
        paymentId: id, sequence, scenario: payment.scenario,
        baselineSuccessRate: Number(gateway.successRate), baselineResponseTimeMs: gateway.responseTimeMs,
      });
      const failureReason = {
        SUCCESS: null, DECLINED: 'Gateway declined the payment', UNAVAILABLE: 'Gateway unavailable; no charge initiated',
        UNKNOWN: 'Gateway request timed out; outcome is unknown',
      }[result.outcome];
      const attemptStatus = { SUCCESS: 'SUCCESS', DECLINED: 'DECLINED', UNAVAILABLE: 'RETRYABLE_FAILURE', UNKNOWN: 'UNCERTAIN' } as const;
      await tx.transactionAttempt.create({
        data: {
          merchantId: payment.merchantId, transactionId: id, gatewayId: gateway.id, sequence,
          status: attemptStatus[result.outcome], gatewayReference: result.reference, responseTimeMs: result.responseTimeMs,
          failureReason, startedAt, completedAt: result.outcome === 'UNKNOWN' ? null : new Date(Math.max(Date.now(), Number(startedAt))),
        },
      });
      await tx.auditLog.create({
        data: {
          merchantId: payment.merchantId, transactionId: id, action: 'GATEWAY_ATTEMPTED',
          metadata: { gateway: gateway.code, sequence, outcome: result.outcome },
        },
      });
      const changes = { gatewayId: gateway.id, gatewayReference: result.reference, failureReason };
      if (result.outcome === 'SUCCESS') {
        const paid = await transition(tx, payment, 'SUCCESS', changes);
        await settlePayment(tx, paid, 'SUCCESS');
      } else if (result.outcome === 'UNKNOWN') {
        await transition(tx, payment, 'PENDING', { ...changes, nextActionAt: nextAction(0) });
      } else if (result.outcome === 'UNAVAILABLE' && sequence < policy.maxAttempts) {
        await tx.transaction.update({ where: { id }, data: { ...changes, nextActionAt: nextAction(sequence - 1) } });
      } else {
        await transition(tx, payment, 'FAILED', changes);
      }
    }, { timeout: 15_000 });
  }

  async function update(merchantId: string, actorId: string, id: string, action: 'cancel' | 'refund') {
    return db.$transaction(async tx => {
      await lockRecord(tx, 'payment', id);
      const payment = await tx.transaction.findUnique({ where: { merchantId_id: { merchantId, id } } });
      if (!payment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
      if (action === 'refund') return publicPayment(await refundPayment(tx, payment, actorId));
      if (payment.status === 'CANCELLED') return publicPayment(payment);
      return publicPayment(await transition(tx, payment, 'CANCELLED', { failureReason: null }, actorId));
    });
  }

  return { create, process, update };
}
