import { Prisma, type PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { publicPayment } from '../repositories/payments.js';
import { ApiError } from '../utils/api-error.js';
import type { ledgerFilter, paymentFilter, settlementInput } from '../validators/operations.js';
import { connectedGateways, gatewayMetrics, metricsFor } from './routing.js';

type Filters = z.infer<typeof paymentFilter>;
type Page = { page: number; limit: number };
type Money = { currency: string; amountMinor: string };
const day = 86_400_000;

function paymentWhere(merchantId: string | undefined, filter: Filters): Prisma.TransactionWhereInput {
  return {
    merchantId,
    status: filter.status,
    paymentMethod: filter.method,
    merchantGateway: filter.gateway ? { gateway: { code: filter.gateway } } : undefined,
    createdAt: filter.from || filter.to ? { gte: filter.from, lt: filter.to } : undefined,
  };
}

const gatewayBrief = { id: true, code: true, name: true } satisfies Prisma.GatewaySelect;
const ledgerInclude = { merchantGateway: { select: { gateway: { select: gatewayBrief } } } } satisfies Prisma.TransactionInclude;

export function pageOptions({ page, limit }: Page) {
  return { skip: (page - 1) * limit, take: limit };
}

export function pageResult<T>(items: T[], total: number, { page, limit }: Page) {
  return { items, total, page, limit };
}

export function createReportingService(db: PrismaClient) {
  async function ledger(merchantId: string, filter: z.infer<typeof ledgerFilter>) {
    const where = paymentWhere(merchantId, filter);
    if (filter.search) {
      const search = filter.search;
      const exactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search);
      where.OR = [
        ...(exactId ? [{ id: search }] : []),
        { merchantReference: { contains: search.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } },
      ];
    }
    const order: Record<typeof filter.sort, Prisma.TransactionOrderByWithRelationInput> = {
      newest: { createdAt: 'desc' }, oldest: { createdAt: 'asc' },
      'amount-high': { amountMinor: 'desc' }, 'amount-low': { amountMinor: 'asc' },
    };
    const [rows, count] = await db.$transaction([
      db.transaction.findMany({ where, ...pageOptions(filter), orderBy: [order[filter.sort], { id: 'desc' }], include: ledgerInclude }),
      db.transaction.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return pageResult(rows.map(publicPayment), count, filter);
  }

  async function payment(merchantId: string, id: string) {
    const row = await db.transaction.findUnique({
      where: { merchantId_id: { merchantId, id } },
      include: {
        ...ledgerInclude,
        attempts: { orderBy: { sequence: 'asc' }, include: { merchantGateway: { select: { gateway: { select: gatewayBrief } } } } },
        routingDecisions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        auditLogs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, action: true, metadata: true, createdAt: true } },
        refunds: true,
      },
    });
    if (!row) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    return { ...publicPayment(row), refunds: row.refunds.map(refund => ({ ...refund, amountMinor: refund.amountMinor.toString() })) };
  }

  async function allGateways(merchantId: string) {
    const gatewayLinks = await connectedGateways(db, merchantId);
    const metrics = await gatewayMetrics(db, merchantId);
    return gatewayLinks.map(({ gateway, active, priority }) => ({
      id: gateway.id, code: gateway.code, name: gateway.name, health: gateway.health, systemActive: gateway.active,
      active, priority, supportedMethods: gateway.supportedMethods,
      baselineSuccessRate: Number(gateway.successRate), baselineResponseTimeMs: gateway.responseTimeMs,
      ...metricsFor(metrics, gateway.id),
    }));
  }

  async function overview(merchantId: string | undefined, filters: Filters) {
    const where = paymentWhere(merchantId, filters);
    const [counts, volume, performance] = await Promise.all([
      db.transaction.groupBy({ by: ['status'], where, _count: { _all: true } }),
      db.transaction.groupBy({ by: ['currency'], where, _sum: { amountMinor: true } }),
      db.transactionAttempt.aggregate({ where: { merchantId, transaction: where }, _avg: { responseTimeMs: true } }),
    ]);
    const statuses = Object.fromEntries(counts.map(result => [result.status, result._count._all]));
    const total = counts.reduce((sum, item) => sum + item._count._all, 0);
    const successful = (statuses.SUCCESS ?? 0) + (statuses.REFUNDED ?? 0);
    const failed = statuses.FAILED ?? 0;
    return {
      total, successful, failed, pending: (statuses.CREATED ?? 0) + (statuses.PROCESSING ?? 0) + (statuses.PENDING ?? 0),
      statuses, volume: volume.map(row => ({ currency: row.currency, amountMinor: String(row._sum.amountMinor ?? 0n) })),
      successRate: successful + failed ? successful / (successful + failed) : null,
      failureRate: successful + failed ? failed / (successful + failed) : null,
      averageResponseTimeMs: performance._avg.responseTimeMs === null ? null : Math.round(performance._avg.responseTimeMs),
    };
  }

  async function performance(merchantId: string | undefined, filters: Filters) {
    const rows = await gatewayMetrics(db, merchantId, paymentWhere(merchantId, filters));
    const gateways = merchantId === undefined
      ? await db.gateway.findMany({ select: { ...gatewayBrief, health: true, active: true }, orderBy: { code: 'asc' } })
      : (await connectedGateways(db, merchantId)).map(({ gateway, active }) => ({
        id: gateway.id, name: gateway.name, code: gateway.code, health: gateway.health, active: active && gateway.active,
      }));
    return gateways.map(gateway => ({ ...gateway, ...metricsFor(rows, gateway.id) }));
  }

  async function trend(merchantId: string | undefined, filters: Filters) {
    const end = filters.to ?? new Date();
    const requestedStart = filters.from ?? new Date(Number(end) - 13 * day);
    const start = new Date(Math.max(Number(requestedStart), Number(end) - 31 * day));
    if (start >= end) return [];
    const firstDay = Date.parse(start.toISOString().slice(0, 10));
    const dates = Array.from({ length: Math.ceil((Number(end) - firstDay) / day) }, (_, index) => firstDay + index * day);
    return Promise.all(dates.map(async date => {
      const where = paymentWhere(merchantId, {
        ...filters,
        from: new Date(Math.max(date, Number(start))),
        to: new Date(Math.min(date + day, Number(end))),
      });
      const rows = await db.transaction.groupBy({ by: ['currency'], where, _count: { _all: true }, _sum: { amountMinor: true } });
      return {
        date: new Date(date).toISOString().slice(0, 10),
        total: rows.reduce((total, row) => total + row._count._all, 0),
        volume: rows.map(row => ({ currency: row.currency, amountMinor: String(row._sum.amountMinor ?? 0n) })),
      };
    }));
  }

  async function importSettlement(merchantId: string, input: z.infer<typeof settlementInput>) {
    const links = await connectedGateways(db, merchantId);
    const gateway = links.find(link => link.gateway.code === input.gateway);
    if (!gateway) throw new ApiError(404, 'GATEWAY_NOT_FOUND', 'Gateway not found');
    const saved = await db.settlementRecord.create({
      data: {
        merchantId, gatewayId: gateway.gatewayId, gatewayReference: input.gatewayReference, currency: input.currency,
        amountMinor: BigInt(input.amountMinor), status: input.status, settledAt: input.settledAt,
      },
    });
    return { ...saved, amountMinor: String(saved.amountMinor) };
  }

  async function reconcile(merchantId: string, from: Date, to: Date) {
    return db.$transaction(async tx => {
      const maxRows = 10_000;
      const payments = await tx.transaction.findMany({
        where: {
          merchantId, gatewayId: { not: null }, gatewayReference: { not: null },
          createdAt: { gte: from, lt: to },
        },
        select: { id: true, gatewayId: true, gatewayReference: true, status: true, currency: true, amountMinor: true },
        take: maxRows + 1,
      });
      const settlements = await tx.settlementRecord.findMany({
        where: { merchantId, settledAt: { gte: from, lt: to } }, take: maxRows + 1,
        orderBy: [{ simulatorGenerated: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      if (payments.length > maxRows || settlements.length > maxRows) {
        throw new ApiError(422, 'RECONCILIATION_LIMIT', 'Choose a shorter reconciliation interval');
      }
      const keyFor = (gatewayId: string | null, reference: string | null) => JSON.stringify([gatewayId, reference]);
      const groups = new Map<string, typeof settlements>();
      for (const settlement of settlements) {
        const key = keyFor(settlement.gatewayId, settlement.gatewayReference);
        const group = groups.get(key);
        if (group) group.push(settlement);
        else groups.set(key, [settlement]);
      }

      const details: { kind: string; paymentId?: string; reference: string; count?: number; expected?: Money | string; actual?: Money | string }[] = [];
      let checked = 0;
      let matched = 0;
      let missing = 0;
      let mismatched = 0;
      let duplicates = 0;
      const money = (record: { currency: string; amountMinor: bigint }) => ({ currency: record.currency, amountMinor: String(record.amountMinor) });
      for (const payment of payments) {
        const key = keyFor(payment.gatewayId, payment.gatewayReference);
        const group = groups.get(key) ?? [];
        if (!group.length && !['SUCCESS', 'REFUNDED'].includes(payment.status)) continue;
        const reference = payment.gatewayReference!;
        const common = { paymentId: payment.id, reference };
        checked++;
        groups.delete(key);
        if (!group.length) {
          missing++;
          details.push({ ...common, kind: 'MISSING_SETTLEMENT' });
          continue;
        }
        let differs = false;
        if (group.length > 1) {
          duplicates += group.length - 1;
          differs = true;
          details.push({ ...common, kind: 'DUPLICATE_SETTLEMENT', count: group.length });
        }
        for (const entry of group) {
          if (payment.amountMinor !== entry.amountMinor || payment.currency !== entry.currency) {
            differs = true;
            details.push({ ...common, kind: 'AMOUNT_MISMATCH', expected: money(payment), actual: money(entry) });
          }
          if (payment.status !== entry.status) {
            differs = true;
            details.push({ ...common, kind: 'STATUS_MISMATCH', expected: payment.status, actual: entry.status });
          }
        }
        if (differs) mismatched++;
        else matched++;
      }
      for (const group of groups.values()) {
        const reference = group[0].gatewayReference;
        details.push({ kind: 'MISSING_PAYMENT', reference });
        if (group.length > 1) {
          duplicates += group.length - 1;
          details.push({ kind: 'DUPLICATE_SETTLEMENT', reference, count: group.length });
        }
      }

      return tx.reconciliationReport.create({
        data: {
          merchantId, periodStart: from, periodEnd: to, checked, matched, mismatched, missing, duplicates, details,
          status: details.length ? 'DISCREPANCIES' : 'MATCHED',
        },
      });
    }, { isolationLevel: 'RepeatableRead', timeout: 20_000 });
  }

  return { ledger, payment, allGateways, overview, performance, trend, importSettlement, reconcile };
}
