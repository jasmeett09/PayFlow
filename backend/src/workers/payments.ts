import type { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { createPaymentService, type RetryPolicy } from '../services/payments.js';

type PaymentJob = { id: string };

export async function startPaymentWorker(db: PrismaClient, redisUrl: string, logger: Logger, policy: RetryPolicy, queueName = 'payflow-payments') {
  const queueConnection = new Redis(redisUrl, {
    lazyConnect: true, enableOfflineQueue: false, commandTimeout: 3_000, maxRetriesPerRequest: 1,
  });
  queueConnection.on('error', () => logger.warn('Payment queue Redis connection unavailable'));
  try {
    await queueConnection.connect();
    await queueConnection.ping();
  } catch (error) {
    queueConnection.disconnect();
    throw error;
  }

  const queue = new Queue<PaymentJob>(queueName, { connection: queueConnection });
  queue.on('error', () => logger.warn('Payment queue unavailable'));
  const workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  workerConnection.on('error', () => logger.warn('Worker Redis connection unavailable'));
  const { process } = createPaymentService(db, policy);
  const worker = new Worker<PaymentJob>(queueName, job => process(job.data.id), {
    connection: workerConnection, concurrency: 5,
  });
  worker.on('error', () => logger.warn('Payment worker encountered an infrastructure error'));
  worker.on('failed', job => logger.error({ paymentId: job?.data.id }, 'Payment job failed and remains eligible for recovery'));

  let inFlight: Promise<void> | undefined;
  async function dispatch() {
    try {
      const pending = await db.transaction.findMany({
        where: { nextActionAt: { lte: new Date() } }, orderBy: { nextActionAt: 'asc' },
        select: { id: true, nextActionAt: true }, take: 100,
      });
      if (pending.length) await queue.addBulk(pending.map(({ id, nextActionAt }) => ({
        name: 'advance', data: { id }, opts: {
          jobId: `${id}-${nextActionAt!.getTime()}`,
          attempts: 3, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: true, removeOnFail: true,
        },
      })));
    } catch {
      logger.error('Could not dispatch due payments. PostgreSQL retains the pending actions');
    }
  }

  const runDispatch = () => {
    if (!inFlight) inFlight = dispatch().finally(() => { inFlight = undefined; });
  };
  const timer = setInterval(runDispatch, 500);
  runDispatch();

  return {
    async healthy() {
      if (!worker.isRunning() || workerConnection.status !== 'ready') return false;
      return await queueConnection.ping() === 'PONG';
    },
    async close() {
      clearInterval(timer);
      await inFlight;
      try {
        await Promise.all([worker.close(), queue.close()]);
      } finally {
        workerConnection.disconnect();
        queueConnection.disconnect();
      }
    },
  };
}
