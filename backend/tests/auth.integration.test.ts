import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type PrismaClient } from '@prisma/client';
import express from 'express';
import jwt from 'jsonwebtoken';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/config/database.js';
import { authenticate, requireRole } from '../src/middleware/auth.js';
import { handleErrors } from '../src/middleware/errors.js';
import { createAuthRepository } from '../src/repositories/auth.js';
import { createAuthService } from '../src/services/auth.js';

const jwtSecret = randomBytes(32).toString('hex');
const corsOrigin = 'http://localhost:5173';
const logger = pino({ level: 'silent' });
const schema = `payflow_test_${randomUUID().replaceAll('-', '')}`;
const password = 'synthetic test password';
let db: PrismaClient | undefined;
let api: ReturnType<typeof createApp>;
let testDatabaseUrl: string;

function database() {
  if (!db) throw new Error('Test database is not initialized');
  return db;
}

beforeAll(() => {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test database');

  const url = new URL(connectionString);
  url.searchParams.set('schema', schema);
  testDatabaseUrl = url.toString();
  db = createDatabase(testDatabaseUrl);
  const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: 'pipe',
  });
  api = createApp({ db, jwtSecret, corsOrigin, logger });
}, 60_000);

afterAll(async () => {
  if (!db) return;
  try {
    // The identifier is generated locally from a UUID for this suite.
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await db.$disconnect();
  }
});

function register(email: string) {
  return request(api).post('/api/v1/auth/register').send({
    merchantName: '  Example Merchant  ',
    email,
    password,
  });
}

function bearer(accessToken: string) {
  return `Bearer ${accessToken}`;
}

describe('Phase 1 authentication API', () => {
  test('reports database readiness, security headers and the allowed origin', async () => {
    const response = await request(api).get('/api/v1/health').set('Origin', corsOrigin).expect(200);
    expect(response.body).toEqual({ data: { status: 'ok' } });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['access-control-allow-origin']).toBe(corsOrigin);
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  test('registers a merchant and audit entry, then logs in and retrieves the identity', async () => {
    const created = await register('  OWNER@EXAMPLE.TEST ').expect(201);
    const { user, accessToken } = created.body.data;
    expect(user).toEqual({
      id: expect.any(String),
      email: 'owner@example.test',
      role: 'MERCHANT',
      merchant: { id: expect.any(String), name: 'Example Merchant' },
    });
    expect(created.body.data.expiresIn).toBe(900);
    expect(created.headers['cache-control']).toBe('no-store');

    const stored = await database().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).toMatch(/^\$2[ab]\$12\$/);
    expect(stored.passwordHash).not.toBe(password);
    const audit = await database().auditLog.findFirstOrThrow({ where: { actorId: user.id } });
    expect(audit).toMatchObject({ merchantId: user.merchant.id, action: 'MERCHANT_REGISTERED' });

    const login = await request(api).post('/api/v1/auth/login')
      .send({ email: 'owner@example.test', password }).expect(200);
    expect(login.body.data.user).toEqual(user);
    for (const token of [accessToken, login.body.data.accessToken]) {
      const me = await request(api).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(200);
      expect(me.body).toEqual({ data: user });
    }
  });

  test('rejects simultaneous duplicate registrations without creating an orphan merchant', async () => {
    const merchantsBefore = await database().merchant.count();
    const auditsBefore = await database().auditLog.count();
    const responses = await Promise.all([
      register('race@example.test'),
      register('RACE@example.test'),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.status === 409)?.body.error.code).toBe('EMAIL_IN_USE');
    expect(await database().merchant.count()).toBe(merchantsBefore + 1);
    expect(await database().auditLog.count()).toBe(auditsBefore + 1);
  });

  test('returns the same response for an unknown account and an incorrect password', async () => {
    await register('credentials@example.test').expect(201);
    const tryLogin = (email: string) => request(api).post('/api/v1/auth/login')
      .send({ email, password: 'incorrect password' }).expect(401);
    const wrongPassword = await tryLogin('credentials@example.test');
    const unknownEmail = await tryLogin('unknown@example.test');
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('rejects missing, invalid and expired tokens', async () => {
    const created = await register('tokens@example.test').expect(201);
    const expired = jwt.sign({}, jwtSecret, {
      subject: created.body.data.user.id, issuer: 'payflow', audience: 'payflow-api', expiresIn: -1,
    });
    const missing = await request(api).get('/api/v1/auth/me').expect(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    for (const token of ['invalid', expired]) {
      const response = await request(api).get('/api/v1/auth/me').set('Authorization', bearer(token)).expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  test('validates registration fields and malformed bodies', async () => {
    await request(api).post('/api/v1/auth/register').send({
      merchantName: 'Example', email: 'not-an-email', password: 'short', role: 'ADMIN',
    }).expect(400).expect(response => expect(response.body.error.code).toBe('VALIDATION_ERROR'));
    await request(api).post('/api/v1/auth/register').send({
      merchantName: 'Example', email: 'bytes@example.test', password: '🧪'.repeat(19),
    }).expect(400);
    await request(api).post('/api/v1/auth/login').type('json').send('{').expect(400)
      .expect(response => expect(response.body.error.code).toBe('INVALID_JSON'));
  });

  test('loads the role from PostgreSQL and enforces an administrator role guard', async () => {
    const { body } = await register('merchant-role@example.test').expect(201);
    const email = 'admin-role@example.test';
    const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const seedAdmin = (seedEmail: string) => execFileSync(process.execPath, [tsxCli, 'prisma/seed.ts'], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl, SEED_ADMIN_EMAIL: seedEmail, SEED_ADMIN_PASSWORD: password },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(seedAdmin(email)).toContain('Administrator provisioned');
    expect(seedAdmin(email)).toContain('Administrator already exists');
    expect(() => seedAdmin('merchant-role@example.test')).toThrow('The seed email belongs to an existing merchant');
    expect(await database().auditLog.count({ where: { action: 'ADMIN_PROVISIONED' } })).toBe(1);
    const admin = await request(api).post('/api/v1/auth/login').send({ email, password }).expect(200);
    expect(admin.body.data.user).toMatchObject({ role: 'ADMIN', merchant: null });

    const guarded = express();
    const auth = createAuthService(createAuthRepository(database()), jwtSecret);
    guarded.get('/admin', authenticate(auth), requireRole('ADMIN'), (_req, res) => res.sendStatus(204));
    guarded.use(handleErrors(logger));

    await request(guarded).get('/admin').set('Authorization', bearer(body.data.accessToken)).expect(403);
    await request(guarded).get('/admin').set('Authorization', bearer(admin.body.data.accessToken)).expect(204);

    await database().user.update({
      where: { email },
      data: { role: 'MERCHANT', merchantId: body.data.user.merchant.id },
    });
    await request(guarded).get('/admin').set('Authorization', bearer(admin.body.data.accessToken)).expect(403);
  }, 15_000);

  test('enforces the tenant boundary when recording a payment attempt', async () => {
    const first = await register('first-tenant@example.test').expect(201);
    const second = await register('second-tenant@example.test').expect(201);
    const firstMerchant = first.body.data.user.merchant.id;
    const secondMerchant = second.body.data.user.merchant.id;
    const gateway = await database().gateway.create({
      data: { code: 'test-gateway', name: 'Test Gateway', successRate: 1, responseTimeMs: 200, supportedMethods: ['CARD'] },
    });
    await database().merchantGateway.createMany({
      data: [firstMerchant, secondMerchant].map(merchantId => ({ merchantId, gatewayId: gateway.id })),
    });
    const payment = await database().transaction.create({
      data: { merchantId: firstMerchant, amountMinor: 500, currency: 'USD', paymentMethod: 'CARD' },
    });
    const attempt = { transactionId: payment.id, gatewayId: gateway.id, sequence: 1 };
    await expect(database().transactionAttempt.create({
      data: { ...attempt, merchantId: secondMerchant },
    })).rejects.toMatchObject({ code: 'P2003' });
    await expect(database().transactionAttempt.create({
      data: { ...attempt, merchantId: firstMerchant },
    })).resolves.toMatchObject({ transactionId: payment.id, merchantId: firstMerchant });
  });

  test('rate limits credential submissions', async () => {
    const fresh = createApp({ db: database(), jwtSecret, corsOrigin, logger });
    for (let index = 0; index < 30; index++) {
      await request(fresh).post('/api/v1/auth/login').send({}).expect(400);
    }
    const response = await request(fresh).post('/api/v1/auth/register').send({}).expect(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
