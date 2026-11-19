import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { handleErrors } from './middleware/errors.js';
import { createAuthRepository } from './repositories/auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createOperationsRouter } from './routes/operations.js';
import type { RetryPolicy } from './services/payments.js';
import type { WebhookSecrets } from './services/webhooks.js';
import { createAuthService } from './services/auth.js';
import { ApiError } from './utils/api-error.js';

type AppOptions = {
  db: PrismaClient;
  jwtSecret: string;
  corsOrigin: string;
  logger: Logger;
  webhookSecrets?: WebhookSecrets;
  retryPolicy?: RetryPolicy;
  workerHealth?: () => Promise<boolean>;
  trustedProxyHops?: number;
};

export function createApp({ db, jwtSecret, corsOrigin, logger, webhookSecrets = {}, retryPolicy, workerHealth, trustedProxyHops = 0 }: AppOptions) {
  const app = express();
  const auth = createAuthService(createAuthRepository(db), jwtSecret);
  app.disable('x-powered-by');
  if (trustedProxyHops) app.set('trust proxy', trustedProxyHops);
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.set('X-Request-Id', requestId);
    res.on('finish', () => {
      logger.info({
        requestId,
        method: req.method,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      }, 'API request');
    });
    next();
  });

  app.use(helmet());
  app.use(cors({ origin: corsOrigin, exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Idempotency-Replayed'] }));
  app.get('/api/v1/health', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database unavailable');
    }
    if (workerHealth && !(await workerHealth().catch(() => false))) {
      throw new ApiError(503, 'WORKER_UNAVAILABLE', 'Payment worker unavailable');
    }
    res.json({ data: { status: 'ok' } });
  });
  app.use('/api/v1/auth', createAuthRouter(auth));
  app.use('/api/v1', createOperationsRouter(db, auth, webhookSecrets, retryPolicy));
  app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint not found')));
  app.use(handleErrors(logger));
  return app;
}
