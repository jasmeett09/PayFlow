import { GatewayHealth, PaymentMethod, PaymentScenario, TransactionStatus, WebhookType } from '@prisma/client';
import { z } from 'zod';
import { gatewayCodes } from '../adapters/simulator.js';

export const uuid = z.uuid();
export const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
export const amountMinor = z.string().regex(/^[1-9][0-9]{0,14}$/);
export const gatewayCode = z.enum(gatewayCodes);
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/^[^\u0000-\u001F\u007F]+$/u);
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value));

export const paymentInput = z.strictObject({
  amountMinor, currency,
  paymentMethod: z.enum(PaymentMethod),
  merchantReference: safeText(120).optional(),
  scenario: z.enum(PaymentScenario).default('NORMAL'),
});

export const windowFilter = z.object({ from: instant.optional(), to: instant.optional() }).refine(
  value => !value.from || !value.to || value.from < value.to, { path: ['to'], message: 'End must be after start' },
);
export const paymentFilter = windowFilter.safeExtend({
  status: z.enum(TransactionStatus).optional(),
  method: z.enum(PaymentMethod).optional(),
  gateway: gatewayCode.optional(),
});
export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const ledgerFilter = paymentFilter.safeExtend({
  ...pagination.shape,
  search: safeText(120).optional(),
  sort: z.enum(['newest', 'oldest', 'amount-high', 'amount-low']).default('newest'),
});

export const gatewayPatch = z.strictObject({
  active: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
}).refine(value => Object.keys(value).length > 0);
export const gatewayHealthPatch = z.strictObject({
  health: z.enum(GatewayHealth),
  active: z.boolean().optional(),
});
export const routingWeights = z.strictObject({
  availability: z.number().int().min(0).max(100),
  successRate: z.number().int().min(0).max(100),
  responseTime: z.number().int().min(0).max(100),
  priority: z.number().int().min(0).max(100),
}).refine(value => Object.values(value).some(weight => weight > 0));
export const routePreview = z.strictObject({ paymentMethod: z.enum(PaymentMethod), amountMinor });
export const webhookInput = z.strictObject({
  eventId: safeText(128),
  type: z.enum(WebhookType),
  gatewayReference: safeText(128),
});
export const reconciliationInput = z.strictObject({ from: instant, to: instant }).refine(
  value => value.to > value.from && Number(value.to) - Number(value.from) <= 93 * 86_400_000,
  { path: ['to'], message: 'Choose an interval of up to 93 days' },
);
export const settlementInput = z.strictObject({
  gateway: gatewayCode,
  gatewayReference: safeText(128),
  amountMinor, currency,
  status: z.enum(['SUCCESS', 'REFUNDED', 'FAILED', 'PENDING']),
  settledAt: instant,
});
export const merchantSettings = z.strictObject({ name: safeText(120) });
