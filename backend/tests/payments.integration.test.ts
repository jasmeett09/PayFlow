import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { PrismaClient, TransactionStatus } from '@prisma/client';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/config/database.js';
import { createPaymentService } from '../src/services/payments.js';
import { startPaymentWorker } from '../src/workers/payments.js';

const jwtSecret = randomBytes(32).toString('hex');
const signingSecret = randomBytes(32).toString('hex');
const logger = pino({ level: 'silent' });
const retry = { maxAttempts: 3, maxVerifications: 2, baseDelayMs: 25 };
const schema = 'payflow_test_' + randomUUID().replaceAll('-', '');
let db: PrismaClient;
let app: ReturnType<typeof createApp>;
let payments: ReturnType<typeof createPaymentService>;
let token: string;
let otherToken: string;

const testPayment = { amountMinor: '12500', currency: 'USD', paymentMethod: 'CARD', scenario: 'FAILOVER' };
const headers = (value: string) => ({ Authorization: 'Bearer ' + value });
const owner = () => headers(token);
const other = () => headers(otherToken);
const read = (path: string) => request(app).get('/api/v1' + path).set(owner());
const create = (key: string, input = testPayment, auth = owner()) =>
  request(app).post('/api/v1/payments').set(auth).set('Idempotency-Key', key).send(input);
const detail = async (id: string) => (await read('/payments/' + id).expect(200)).body.data;
const mutate = (method: 'post' | 'patch', path: string, value?: object) =>
  request(app)[method]('/api/v1' + path).set(owner()).send(value ?? {});

async function advance(id: string, status: TransactionStatus) {
  for (let index = 0; index < 20; index++) {
    await payments.process(id);
    const transaction = await db.transaction.findUniqueOrThrow({ where: { id } });
    if (transaction.status === status && (status !== 'PENDING' || !transaction.nextActionAt)) return;
    await delay(30);
  }
  expect(await detail(id)).toMatchObject({ status });
  if (status === 'PENDING') expect((await db.transaction.findUniqueOrThrow({ where: { id } })).nextActionAt).toBeNull();
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL for integration tests');
  const dbUrl = new URL(process.env.TEST_DATABASE_URL);
  dbUrl.searchParams.set('schema', schema);
  db = createDatabase(dbUrl.toString());
  const prisma = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
  execFileSync(process.execPath, [prisma, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: dbUrl.toString() }, stdio: 'pipe',
  });

  payments = createPaymentService(db, retry);
  app = createApp({
    db, jwtSecret, logger, retryPolicy: retry, corsOrigin: 'http://localhost:5173',
    webhookSecrets: { 'gateway-a': signingSecret, 'gateway-b': signingSecret, 'gateway-c': signingSecret },
  });
  for (const email of ['first@example.test', 'second@example.test']) {
    const response = await request(app).post('/api/v1/auth/register').send({
      email, password: 'local integration test password', merchantName: email.startsWith('first') ? 'First shop' : 'Second shop',
    }).expect(201);
    if (email.startsWith('first')) token = response.body.data.accessToken;
    else otherToken = response.body.data.accessToken;
  }
}, 60_000);

afterAll(async () => {
  if (!db) return;
  try {
    // The schema is unique to this test file and named with a generated UUID.
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally { await db.$disconnect(); }
});

describe('Payment orchestration API', () => {
  test('uses merchant-specific gateway priorities and excludes unhealthy, inactive and incompatible gateways', async () => {
    const { body: { data: gateways } } = await read('/gateways').expect(200);
    expect(gateways.map((gateway: { name: string }) => gateway.name)).toEqual(['Gateway A', 'Gateway B', 'Gateway C']);
    const [a, b, c] = gateways;
    await mutate('patch', '/gateways/' + a.id, { active: false }).expect(200);
    await mutate('patch', '/routing/config', { availability: 0, successRate: 0, responseTime: 0, priority: 100 }).expect(200);
    await db.gateway.update({ where: { id: b.id }, data: { health: 'UNHEALTHY' } });

    try {
      const preview = await mutate('post', '/routing/preview', { paymentMethod: 'WALLET', amountMinor: '1000' }).expect(200);
      expect(preview.body.data).toMatchObject({ selectedGatewayId: c.id, reason: expect.stringContaining('Gateway C') });
      expect(preview.body.data.candidates.map((item: { exclusion: string | null }) => item.exclusion)).toEqual(['Inactive', 'Unhealthy', null]);
      const unsupported = await mutate('post', '/routing/preview', { paymentMethod: 'UPI', amountMinor: '1000' }).expect(200);
      expect(unsupported.body.data.selectedGatewayId).toBeNull();
      const unavailable = await create('no-eligible', { ...testPayment, paymentMethod: 'UPI' }).expect(202);
      await advance(unavailable.body.data.id, 'FAILED');
      const failed = await detail(unavailable.body.data.id);
      expect(failed.attempts).toHaveLength(0);
      expect(failed.routingDecisions[0].selectedGatewayId).toBeNull();
      const otherGateways = await request(app).get('/api/v1/gateways').set(other()).expect(200);
      expect(otherGateways.body.data.find((gateway: { id: string }) => gateway.id === a.id).active).toBe(true);
      await request(app).patch('/api/v1/admin/gateways/gateway-b').set(owner()).send({ health: 'HEALTHY' }).expect(403);
    } finally {
      await db.gateway.update({ where: { id: b.id }, data: { health: 'HEALTHY' } });
      await mutate('patch', '/gateways/' + a.id, { active: true }).expect(200);
      await mutate('patch', '/routing/config', { availability: 25, successRate: 45, responseTime: 20, priority: 10 }).expect(200);
    }
  });

  test('replays the original response for eight concurrent requests and rejects fingerprint changes', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => create('same-payment').expect(202)));
    const id = results[0].body.data.id;
    expect(new Set(results.map(result => result.body.data.id)).size).toBe(1);
    expect(results.filter(result => result.headers['idempotency-replayed'] === 'false')).toHaveLength(1);
    expect(await db.idempotencyRecord.count({ where: { key: 'same-payment' } })).toBe(1);
    expect(await db.transaction.count({ where: { id } })).toBe(1);

    await advance(id, 'SUCCESS');
    const identical = await create('same-payment').expect(202);
    expect(identical.body).toEqual(results[0].body);
    expect(identical.body.data.status).toBe('CREATED');
    await create('same-payment', { ...testPayment, amountMinor: '100' }).expect(409);
    const secondMerchant = await create('same-payment', testPayment, other()).expect(202);
    expect(secondMerchant.body.data.id).not.toBe(id);
  });

  test('isolates transaction detail, actions, listings, decisions, and settings', async () => {
    const result = await create('scoped', { ...testPayment, merchantReference: 'match_123%' } as typeof testPayment).expect(202);
    const id = result.body.data.id;
    await request(app).get('/api/v1/payments/' + id).set(other()).expect(404);
    await request(app).post('/api/v1/payments/' + id + '/cancel').set(other()).expect(404);
    await request(app).get('/api/v1/payments/' + id).expect(401);
    const found = await read('/payments?search=' + encodeURIComponent('match_123%')).expect(200);
    expect(found.body.data.items.map((item: { id: string }) => item.id)).toEqual([id]);
    const scoped = await request(app).get('/api/v1/payments?search=' + id).set(other()).expect(200);
    expect(scoped.body.data.total).toBe(0);
    const decisions = await request(app).get('/api/v1/routing/decisions').set(other()).expect(200);
    expect(decisions.body.data.total).toBe(0);
    await mutate('patch', '/settings', { name: 'Updated shop' }).expect(200);
    const profile = await read('/auth/me').expect(200);
    expect(profile.body.data.merchant.name).toBe('Updated shop');
    const differentProfile = await request(app).get('/api/v1/auth/me').set(other()).expect(200);
    expect(differentProfile.body.data.merchant.name).toBe('Second shop');
  });

  test('fails over after a retryable failure, records the history, and stops after a business decline', async () => {
    const { body: { data: created } } = await create('recoverable').expect(202);
    await advance(created.id, 'SUCCESS');
    const paid = await detail(created.id);
    expect(paid.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(['RETRYABLE_FAILURE', 'SUCCESS']);
    expect(paid.attempts[0].gatewayId).not.toEqual(paid.attempts[1].gatewayId);
    expect(paid.routingDecisions).toHaveLength(2);
    expect(paid.auditLogs.some((event: { metadata?: { to: string } }) => event.metadata?.to === 'SUCCESS')).toBe(true);

    const decline = await create('declined', { ...testPayment, scenario: 'DECLINE' }).expect(202);
    await advance(decline.body.data.id, 'FAILED');
    const failed = await detail(decline.body.data.id);
    expect(failed.attempts).toHaveLength(1);
    expect(failed.attempts[0].status).toBe('DECLINED');
    await mutate('post', '/payments/' + failed.id + '/refund').expect(409);
  });

  test('confirms a timeout before succeeding or selecting an alternative gateway', async () => {
    for (const scenario of ['TIMEOUT_SUCCESS', 'TIMEOUT_FAILOVER']) {
      const { body: { data: initial } } = await create(scenario, { ...testPayment, scenario }).expect(202);
      await payments.process(initial.id);
      const pending = await detail(initial.id);
      expect(pending.status).toBe('PENDING');
      expect(pending.attempts).toHaveLength(1);
      await mutate('post', '/payments/' + initial.id + '/cancel').expect(409);

      await advance(initial.id, 'SUCCESS');
      const resolved = await detail(initial.id);
      expect(resolved.attempts[0].verificationCount).toBe(2);
      expect(resolved.attempts).toHaveLength(scenario === 'TIMEOUT_SUCCESS' ? 1 : 2);
      if (scenario === 'TIMEOUT_FAILOVER') expect(resolved.attempts[0].failureReason).toContain('confirmed no charge');
    }
  });

  test('holds unresolved timeouts and applies concurrent duplicate webhooks exactly once', async () => {
    const { body: { data: initial } } = await create('pending', { ...testPayment, scenario: 'TIMEOUT_UNKNOWN' }).expect(202);
    await advance(initial.id, 'PENDING');
    const pending = await detail(initial.id);
    expect(pending.attempts).toHaveLength(1);
    expect(pending.attempts[0].verificationCount).toBe(2);
    const gateway = pending.merchantGateway.gateway.code;
    const payload = { eventId: 'evt-integration-payment', type: 'PAYMENT_SUCCESSFUL', gatewayReference: pending.gatewayReference };
    const bytes = JSON.stringify(payload);
    const signature = createHmac('sha256', signingSecret).update(bytes).digest('hex');
    const deliver = (body: string, signed: string) => request(app).post('/api/v1/webhooks/' + gateway)
      .type('json').set('X-PayFlow-Signature', signed).send(body);
    await deliver(bytes, '0'.repeat(64)).expect(401);
    await Promise.all(Array.from({ length: 4 }, () => deliver(bytes, signature).expect(200)));
    const after = await detail(initial.id);
    expect(after.status).toBe('SUCCESS');
    expect(after.attempts).toHaveLength(1);
    const logs = await read('/webhooks').expect(200);
    expect(logs.body.data.items).toHaveLength(1);
    expect(logs.body.data.items[0]).toMatchObject({ status: 'PROCESSED', processingAttempts: 1, deliveryCount: 4 });
    const second = await request(app).get('/api/v1/webhooks').set(other()).expect(200);
    expect(second.body.data.items).toHaveLength(0);
    await request(app).post('/api/v1/webhooks/' + logs.body.data.items[0].id + '/retry').set(other()).expect(404);
  });

  test('cancels an unstarted payment and processes repeated refunds only once', async () => {
    const cancelled = await create('cancel-it').expect(202);
    const id = cancelled.body.data.id;
    await mutate('post', '/payments/' + id + '/cancel').expect(200);
    await payments.process(id);
    expect(await detail(id)).toMatchObject({ status: 'CANCELLED', attempts: [] });
    await mutate('post', '/payments/' + id + '/refund').expect(409);

    const paid = await create('refund-it').expect(202);
    const paidId = paid.body.data.id;
    await advance(paidId, 'SUCCESS');
    await mutate('post', '/payments/' + paidId + '/cancel').expect(409);
    const refunds = await Promise.all([0, 1, 2].map(() => mutate('post', '/payments/' + paidId + '/refund').expect(200)));
    expect(refunds.every(response => response.body.data.status === 'REFUNDED')).toBe(true);
    expect((await detail(paidId)).refunds).toHaveLength(1);
  });

  test('reconciles missing payments, missing settlements, duplicate rows, amount differences and status differences', async () => {
    const one = await create('reconcile-one').expect(202);
    const two = await create('reconcile-two').expect(202);
    await advance(one.body.data.id, 'SUCCESS');
    await advance(two.body.data.id, 'SUCCESS');
    const paid = await detail(one.body.data.id);
    const missing = await detail(two.body.data.id);
    await db.settlementRecord.deleteMany({ where: { merchantId: missing.merchantId, gatewayReference: missing.gatewayReference } });
    const settlement = {
      gateway: paid.merchantGateway.gateway.code, gatewayReference: paid.gatewayReference,
      amountMinor: '9900', currency: 'USD', status: 'FAILED', settledAt: new Date().toISOString(),
    };
    await mutate('post', '/reconciliation/settlements', settlement).expect(201);
    await mutate('post', '/reconciliation/settlements', { ...settlement, gatewayReference: 'unmatched-external-reference' }).expect(201);
    const report = await mutate('post', '/reconciliation/run', {
      from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString(),
    }).expect(201);
    expect(report.body.data.status).toBe('DISCREPANCIES');
    expect(report.body.data.details.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining([
      'MISSING_PAYMENT', 'MISSING_SETTLEMENT', 'DUPLICATE_SETTLEMENT', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH',
    ]));
    await read('/reconciliation/reports/' + report.body.data.id).expect(200);
    await request(app).get('/api/v1/reconciliation/reports/' + report.body.data.id).set(other()).expect(404);
  }, 12_000);

  test('returns scoped database analytics and supports interval filters, pagination, and input validation', async () => {
    const overview = await read('/analytics/overview').expect(200);
    expect(overview.body.data.total).toBeGreaterThan(6);
    expect(overview.body.data.successRate).toBeGreaterThan(0);
    expect(overview.body.data.averageResponseTimeMs).toBeGreaterThan(0);
    expect(overview.body.data.volume).toEqual(expect.arrayContaining([{ currency: 'USD', amountMinor: expect.any(String) }]));
    const future = await read('/analytics/overview?from=2099-01-01T00:00:00Z').expect(200);
    expect(future.body.data.total).toBe(0);
    const second = await request(app).get('/api/v1/analytics/overview').set(other()).expect(200);
    expect(second.body.data.total).toBe(1);
    const gateways = await read('/analytics/gateways').expect(200);
    expect(gateways.body.data.some((item: { total: number }) => item.total > 0)).toBe(true);
    const trend = await read('/analytics/transactions').expect(200);
    expect(trend.body.data.reduce((sum: number, point: { total: number }) => sum + point.total, 0)).toBe(overview.body.data.total);
    const firstPage = await read('/payments?limit=1&page=1').expect(200);
    const nextPage = await read('/payments?limit=1&page=2').expect(200);
    expect(firstPage.body.data.items[0].id).not.toBe(nextPage.body.data.items[0].id);
    await create('invalid-amount', { ...testPayment, amountMinor: '1.23' }).expect(400);
    await request(app).post('/api/v1/payments').set(owner()).send(testPayment).expect(400);
  });

  test.skipIf(!process.env.TEST_REDIS_URL)('hands persisted work to a real BullMQ worker', async () => {
    const worker = await startPaymentWorker(db, process.env.TEST_REDIS_URL!, logger, retry, schema);
    try {
      const { body: { data: initial } } = await create('bullmq-worker').expect(202);
      for (let index = 0; index < 50; index++) {
        if ((await detail(initial.id)).status === 'SUCCESS') break;
        await delay(150);
      }
      expect(await worker.healthy()).toBe(true);
      expect(await detail(initial.id)).toMatchObject({ status: 'SUCCESS', attempts: [{ status: 'RETRYABLE_FAILURE' }, { status: 'SUCCESS' }] });
    } finally {
      await worker.close();
    }
  }, 15_000);
});
