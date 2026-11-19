import 'dotenv/config';
import { z } from 'zod';

export const jwtSecretSchema = z.string().refine(
  secret => Buffer.byteLength(secret, 'utf8') >= 32 && secret.trim() === secret,
  'Provide a JWT secret of at least 32 bytes with no surrounding whitespace',
);

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  JWT_SECRET: jwtSecretSchema,
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://127.0.0.1:6379'),
  WEBHOOK_SECRET_A: z.preprocess(value => value === '' ? undefined : value, jwtSecretSchema.optional()),
  WEBHOOK_SECRET_B: z.preprocess(value => value === '' ? undefined : value, jwtSecretSchema.optional()),
  WEBHOOK_SECRET_C: z.preprocess(value => value === '' ? undefined : value, jwtSecretSchema.optional()),
  PAYMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(3),
  PAYMENT_MAX_VERIFICATIONS: z.coerce.number().int().min(2).max(8).default(4),
  PAYMENT_BACKOFF_MS: z.coerce.number().int().min(100).max(10000).default(750),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),
  CORS_ORIGIN: z.url({ protocol: /^https?$/ }).transform(value => new URL(value).origin)
    .default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export function readConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const fields = result.error.issues.map(issue => issue.path.join('.')).join(', ');
    throw new Error(`Missing or invalid environment configuration: ${fields}`);
  }
  return result.data;
}
