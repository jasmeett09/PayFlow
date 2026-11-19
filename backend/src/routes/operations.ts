import type { PrismaClient } from '@prisma/client';
import { json, raw, Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate, requireRole } from '../middleware/auth.js';
import type { AuthService } from '../services/auth.js';
import { createPaymentService, type RetryPolicy } from '../services/payments.js';
import { createReportingService, pageOptions, pageResult } from '../services/reporting.js';
import { connectedGateways, getWeights, routePayment } from '../services/routing.js';
import { createWebhookService, type WebhookSecrets } from '../services/webhooks.js';
import { ApiError } from '../utils/api-error.js';
import {
  gatewayCode, gatewayHealthPatch, gatewayPatch, idempotencyKey, ledgerFilter, merchantSettings,
  pagination, paymentFilter, paymentInput, reconciliationInput, routePreview, routingWeights,
  settlementInput, uuid,
} from '../validators/operations.js';

const respond = (handler: (req: Request) => Promise<unknown>, status = 200): RequestHandler =>
  async (req, res) => { res.status(status).json({ data: await handler(req) }); };
const merchantId = (req: Request) => req.identity!.merchant!.id;
const recordId = (req: Request) => uuid.parse(req.params.id);
const actorId = (req: Request) => req.identity!.id;

export function createOperationsRouter(db: PrismaClient, auth: AuthService, secrets: WebhookSecrets, policy?: RetryPolicy) {
  const router = Router();
  const merchant = Router();
  const admin = Router();
  const payments = createPaymentService(db, policy);
  const reporting = createReportingService(db);
  const webhooks = createWebhookService(db, secrets);
  const limiter = rateLimit({
    windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Try again later')),
  });

  router.use(limiter);
  router.post('/webhooks/:gateway', raw({ type: 'application/json', limit: '16kb', inflate: false }),
    respond(req => webhooks.receive(gatewayCode.parse(req.params.gateway), req.body, req.get('X-PayFlow-Signature'))));

  const authorize = authenticate(auth);
  merchant.use(authorize, requireRole('MERCHANT'), json({ limit: '32kb' }));
  admin.use(authorize, requireRole('ADMIN'), json({ limit: '32kb' }));

  merchant.post('/payments', async (req, res) => {
    const key = idempotencyKey.parse(req.get('Idempotency-Key'));
    const result = await payments.create(merchantId(req), actorId(req), key, paymentInput.parse(req.body));
    res.set('Idempotency-Replayed', String(result.replayed)).status(result.status).json(result.body);
  });
  merchant.get('/payments', respond(req => reporting.ledger(merchantId(req), ledgerFilter.parse(req.query))));
  merchant.get('/payments/:id', respond(req => reporting.payment(merchantId(req), recordId(req))));
  merchant.post('/payments/:id/cancel', respond(req => payments.update(merchantId(req), actorId(req), recordId(req), 'cancel')));
  merchant.post('/payments/:id/refund', respond(req => payments.update(merchantId(req), actorId(req), recordId(req), 'refund')));

  merchant.get('/gateways', respond(req => reporting.allGateways(merchantId(req))));
  merchant.get('/gateways/:id/health', respond(async req => {
    const id = recordId(req);
    const gateway = (await reporting.allGateways(merchantId(req))).find(item => item.id === id);
    if (!gateway) throw new ApiError(404, 'GATEWAY_NOT_FOUND', 'Gateway not found');
    return gateway;
  }));
  merchant.patch('/gateways/:id', respond(async req => {
    const id = recordId(req);
    const data = gatewayPatch.parse(req.body);
    const owner = merchantId(req);
    if (!(await connectedGateways(db, owner)).some(link => link.gatewayId === id)) {
      throw new ApiError(404, 'GATEWAY_NOT_FOUND', 'Gateway not found');
    }
    return db.$transaction(async tx => {
      const updated = await tx.merchantGateway.update({ where: { merchantId_gatewayId: { merchantId: owner, gatewayId: id } }, data });
      await tx.auditLog.create({ data: { merchantId: owner, actorId: actorId(req), action: 'GATEWAY_CONFIGURATION_UPDATED', metadata: { gatewayId: id, ...data } } });
      return updated;
    });
  }));
  admin.patch('/gateways/:gateway', respond(req => db.gateway.update({
    where: { code: gatewayCode.parse(req.params.gateway) },
    data: gatewayHealthPatch.parse(req.body),
    select: { id: true, code: true, health: true, active: true },
  })));

  merchant.get('/routing/config', respond(async req => ({ strategy: 'WEIGHTED', weights: await getWeights(db, merchantId(req)) })));
  merchant.patch('/routing/config', respond(async req => {
    const weights = routingWeights.parse(req.body);
    const id = merchantId(req);
    await db.$transaction([
      db.merchant.update({ where: { id }, data: { routingWeights: weights } }),
      db.auditLog.create({ data: { merchantId: id, actorId: actorId(req), action: 'ROUTING_WEIGHTS_UPDATED', metadata: weights } }),
    ]);
    return { strategy: 'WEIGHTED', weights };
  }));
  merchant.post('/routing/preview', respond(async req => {
    const input = routePreview.parse(req.body);
    return routePayment(db, merchantId(req), input.paymentMethod);
  }));
  merchant.get('/routing/decisions', respond(async req => {
    const page = pagination.parse(req.query);
    const where = { merchantId: merchantId(req) };
    const [items, count] = await db.$transaction([
      db.routingDecision.findMany({ where, ...pageOptions(page), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      db.routingDecision.count({ where }),
    ]);
    return pageResult(items, count, page);
  }));

  merchant.get('/webhooks', respond(async req => {
    const page = pagination.parse(req.query);
    const where = { merchantId: merchantId(req) };
    const [items, count] = await db.$transaction([
      db.webhookEvent.findMany({ where, ...pageOptions(page), orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        include: { gateway: { select: { code: true, name: true } } } }),
      db.webhookEvent.count({ where }),
    ]);
    return pageResult(items, count, page);
  }));
  merchant.post('/webhooks/:id/retry', respond(req => webhooks.retry(recordId(req), merchantId(req))));

  merchant.post('/reconciliation/settlements', respond(req => reporting.importSettlement(merchantId(req), settlementInput.parse(req.body)), 201));
  merchant.post('/reconciliation/run', respond(req => {
    const { from, to } = reconciliationInput.parse(req.body);
    return reporting.reconcile(merchantId(req), from, to);
  }, 201));
  merchant.get('/reconciliation/reports', respond(async req => {
    const page = pagination.parse(req.query);
    const where = { merchantId: merchantId(req) };
    const [items, count] = await db.$transaction([
      db.reconciliationReport.findMany({ where, ...pageOptions(page), omit: { details: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      db.reconciliationReport.count({ where }),
    ]);
    return pageResult(items, count, page);
  }));
  merchant.get('/reconciliation/reports/:id', respond(async req => {
    const report = await db.reconciliationReport.findFirst({ where: { id: recordId(req), merchantId: merchantId(req) } });
    if (!report) throw new ApiError(404, 'REPORT_NOT_FOUND', 'Reconciliation report not found');
    return report;
  }));

  for (const [path, handler] of [
    ['overview', reporting.overview], ['gateways', reporting.performance], ['transactions', reporting.trend],
  ] as const) {
    merchant.get('/analytics/' + path, respond(req => handler(merchantId(req), paymentFilter.parse(req.query))));
    admin.get('/analytics/' + path, respond(req => handler(undefined, paymentFilter.parse(req.query))));
  }

  merchant.get('/settings', respond(req => db.merchant.findUniqueOrThrow({
    where: { id: merchantId(req) }, select: { id: true, name: true, createdAt: true },
  })));
  merchant.patch('/settings', respond(req => db.$transaction(async tx => {
    const id = merchantId(req);
    const { name } = merchantSettings.parse(req.body);
    const updated = await tx.merchant.update({ where: { id }, data: { name }, select: { id: true, name: true, createdAt: true } });
    await tx.auditLog.create({ data: { merchantId: id, actorId: actorId(req), action: 'MERCHANT_SETTINGS_UPDATED', metadata: { name } } });
    return updated;
  })));

  router.use('/admin', admin);
  // Scope middleware to operational resource paths so unknown routes still return 404.
  router.use((req, res, next) => {
    if (/^\/(payments|gateways|routing|webhooks|reconciliation|analytics|settings)(\/|$)/.test(req.path)) {
      res.set('Cache-Control', 'no-store');
      merchant(req, res, next);
      return;
    }
    next();
  });
  return router;
}
