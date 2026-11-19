import { once } from 'node:events';
import pino from 'pino';
import { createApp } from './app.js';
import { createDatabase } from './config/database.js';
import { readConfig } from './config/env.js';
import { startPaymentWorker } from './workers/payments.js';

const config = readConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = createDatabase(config.DATABASE_URL);
const retryPolicy = {
  maxAttempts: config.PAYMENT_MAX_ATTEMPTS,
  maxVerifications: config.PAYMENT_MAX_VERIFICATIONS,
  baseDelayMs: config.PAYMENT_BACKOFF_MS,
};
let paymentWorker: Awaited<ReturnType<typeof startPaymentWorker>> | undefined;
let startupStep = 'connecting to PostgreSQL';

try {
  await db.$connect();
  await db.$queryRaw`SELECT 1`;
  startupStep = 'connecting to Redis and starting the payment worker';
  paymentWorker = await startPaymentWorker(db, config.REDIS_URL, logger, retryPolicy);
  startupStep = 'starting the HTTP API';
  const app = createApp({
    db, jwtSecret: config.JWT_SECRET, corsOrigin: config.CORS_ORIGIN, logger, retryPolicy,
    workerHealth: paymentWorker.healthy, trustedProxyHops: config.TRUST_PROXY_HOPS,
    webhookSecrets: {
      'gateway-a': config.WEBHOOK_SECRET_A,
      'gateway-b': config.WEBHOOK_SECRET_B,
      'gateway-c': config.WEBHOOK_SECRET_C,
    },
  });
  const server = app.listen(config.PORT, config.HOST);
  await once(server, 'listening');
  logger.info({ host: config.HOST, port: config.PORT }, 'PayFlow API listening');

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(error => {
      if (error) process.exitCode = 1;
      void paymentWorker?.close().finally(() => db.$disconnect()).catch(() => {
        logger.error('Could not close backend connections cleanly');
        process.exitCode = 1;
      });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch {
  logger.error({ startupStep }, 'PayFlow could not start');
  await paymentWorker?.close().catch(() => {});
  await db.$disconnect();
  process.exitCode = 1;
}
