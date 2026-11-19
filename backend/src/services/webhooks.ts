import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { GatewayCode } from '../adapters/simulator.js';
import { lockRecord } from '../repositories/payments.js';
import { ApiError } from '../utils/api-error.js';
import { webhookInput } from '../validators/operations.js';
import { refundPayment, settlePayment, transition } from './payments.js';

export type WebhookSecrets = Partial<Record<GatewayCode, string>>;

const maxProcessingAttempts = 5;

export function createWebhookService(db: PrismaClient, secrets: WebhookSecrets) {
  async function process(id: string, merchantId?: string) {
    try {
      return await db.$transaction(async tx => {
        await lockRecord(tx, 'webhook', id);
        const event = await tx.webhookEvent.findFirst({ where: { id, merchantId } });
        if (!event) throw new ApiError(404, 'WEBHOOK_NOT_FOUND', 'Webhook event not found');
        if (!['RECEIVED', 'FAILED'].includes(event.status) || event.processingAttempts >= maxProcessingAttempts) {
          return event;
        }

        const payload = webhookInput.parse(event.payload);
        const attempt = await tx.transactionAttempt.findUnique({
          where: { gatewayId_gatewayReference: { gatewayId: event.gatewayId, gatewayReference: payload.gatewayReference } },
        });
        let status: 'PROCESSED' | 'IGNORED' = 'IGNORED';
        if (attempt) {
          await lockRecord(tx, 'payment', attempt.transactionId);
          const payment = await tx.transaction.findUniqueOrThrow({
            where: { merchantId_id: { merchantId: attempt.merchantId, id: attempt.transactionId } },
          });
          if (payment.gatewayReference === payload.gatewayReference) {
            if (payment.status === 'PENDING' && event.type === 'PAYMENT_PENDING') status = 'PROCESSED';
            if (payment.status === 'PENDING' && ['PAYMENT_SUCCESSFUL', 'PAYMENT_FAILED'].includes(event.type)) {
              const success = event.type === 'PAYMENT_SUCCESSFUL';
              const failureReason = success ? null : 'Gateway confirmed payment failed';
              await tx.transactionAttempt.update({
                where: { id: attempt.id },
                data: { status: success ? 'SUCCESS' : 'DECLINED', completedAt: new Date(Math.max(Date.now(), Number(attempt.startedAt))), failureReason },
              });
              const updated = await transition(tx, payment, success ? 'SUCCESS' : 'FAILED', { failureReason });
              if (success) await settlePayment(tx, updated, 'SUCCESS');
              status = 'PROCESSED';
            }
            if (payment.status === 'SUCCESS' && event.type === 'REFUND_COMPLETED') {
              await refundPayment(tx, payment);
              status = 'PROCESSED';
            }
          }
        }
        return tx.webhookEvent.update({
          where: { id },
          data: {
            merchantId: attempt?.merchantId, transactionId: attempt?.transactionId, status,
            processedAt: new Date(), processingAttempts: { increment: 1 },
          },
        });
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      await db.webhookEvent.updateMany({
        where: { id, merchantId, status: { in: ['RECEIVED', 'FAILED'] }, processingAttempts: { lt: maxProcessingAttempts } },
        data: { status: 'FAILED', processingAttempts: { increment: 1 }, processedAt: new Date() },
      });
      throw new ApiError(503, 'WEBHOOK_PROCESSING_FAILED', 'Event saved. Retry delivery or retry processing from the webhook log');
    }
  }

  async function receive(code: GatewayCode, body: Buffer, signature: string | undefined) {
    const secret = secrets[code];
    if (!secret) throw new ApiError(503, 'WEBHOOK_UNCONFIGURED', 'Gateway signature verification is unavailable');
    if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature) || !Buffer.isBuffer(body)) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Gateway signature is invalid');
    }
    const expected = createHmac('sha256', secret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Gateway signature is invalid');
    }

    let raw: unknown;
    try { raw = JSON.parse(body.toString('utf8')); }
    catch { throw new ApiError(400, 'INVALID_JSON', 'The webhook body is not valid JSON'); }
    const payload = webhookInput.parse(raw);
    const gateway = await db.gateway.findUniqueOrThrow({ where: { code } });
    const attempt = await db.transactionAttempt.findUnique({
      where: { gatewayId_gatewayReference: { gatewayId: gateway.id, gatewayReference: payload.gatewayReference } },
    });
    const event = await db.webhookEvent.upsert({
      where: { gatewayId_eventId: { gatewayId: gateway.id, eventId: payload.eventId } },
      update: { deliveryCount: { increment: 1 } },
      create: {
        gatewayId: gateway.id, eventId: payload.eventId, type: payload.type, payload,
        merchantId: attempt?.merchantId, transactionId: attempt?.transactionId,
      },
    });
    const saved = webhookInput.parse(event.payload);
    if (saved.type !== payload.type || saved.gatewayReference !== payload.gatewayReference) {
      throw new ApiError(409, 'WEBHOOK_EVENT_CONFLICT', 'Event ID already belongs to a different payload');
    }
    const processed = await process(event.id);
    return { eventId: processed.eventId, status: processed.status, deliveryCount: processed.deliveryCount };
  }

  return { receive, retry: (id: string, merchantId: string) => process(id, merchantId) };
}
