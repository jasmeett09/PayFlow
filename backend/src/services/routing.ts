import type { PaymentMethod, Prisma } from '@prisma/client';
import { gatewayCodes } from '../adapters/simulator.js';

export const defaultWeights = { availability: 25, successRate: 45, responseTime: 20, priority: 10 };
export type Weights = typeof defaultWeights;
type Database = Prisma.TransactionClient;

export async function connectedGateways(db: Database, merchantId: string) {
  const missing = await db.gateway.findMany({
    where: { code: { in: [...gatewayCodes] }, merchants: { none: { merchantId } } },
    select: { id: true, code: true },
  });
  if (missing.length) {
    await db.merchantGateway.createMany({
      data: missing.map(gateway => ({
        merchantId,
        gatewayId: gateway.id,
        priority: gateway.code === 'gateway-a' ? 1 : gateway.code === 'gateway-b' ? 2 : 3,
      })),
      skipDuplicates: true,
    });
  }
  return db.merchantGateway.findMany({
    where: { merchantId, gateway: { code: { in: [...gatewayCodes] } } },
    include: { gateway: true },
    orderBy: [{ priority: 'asc' }, { gateway: { code: 'asc' } }],
  });
}

export async function gatewayMetrics(db: Database, merchantId: string | undefined, filter: Prisma.TransactionWhereInput = {}) {
  return db.transactionAttempt.groupBy({
    by: ['gatewayId', 'status'],
    where: { merchantId, transaction: filter },
    _count: { _all: true, responseTimeMs: true },
      _sum: { responseTimeMs: true },
  });
}

type Metric = Awaited<ReturnType<typeof gatewayMetrics>>[number];

export function metricsFor(rows: Metric[], id: string) {
  const own = rows.filter(row => row.gatewayId === id);
  const total = own.reduce((sum, row) => sum + row._count._all, 0);
  const success = own.find(row => row.status === 'SUCCESS')?._count._all ?? 0;
  const timed = own.reduce((sum, row) => sum + row._count.responseTimeMs, 0);
  const elapsed = own.reduce((sum, row) => sum + (row._sum.responseTimeMs ?? 0), 0);
  return { total, success, successRate: total ? success / total : null, averageResponseTimeMs: timed ? Math.round(elapsed / timed) : null };
}

export async function getWeights(db: Database, merchantId: string): Promise<Weights> {
  const merchant = await db.merchant.findUniqueOrThrow({ where: { id: merchantId }, select: { routingWeights: true } });
  return merchant.routingWeights ? merchant.routingWeights as Weights : defaultWeights;
}

export async function routePayment(db: Database, merchantId: string, method: PaymentMethod, excluded: string[] = []) {
  const gateways = await connectedGateways(db, merchantId);
  const [weights, metrics] = await Promise.all([getWeights(db, merchantId), gatewayMetrics(db, merchantId)]);
  const weightTotal = Object.values(weights).reduce((total, weight) => total + weight, 0);
  const candidates = gateways.map(({ gateway, active, priority }) => {
    let exclusion: string | null = null;
    if (!active || !gateway.active) exclusion = 'Inactive';
    else if (gateway.health === 'UNHEALTHY') exclusion = 'Unhealthy';
    else if (!gateway.supportedMethods.includes(method)) exclusion = 'Unsupported payment method';
    else if (excluded.includes(gateway.id)) exclusion = 'Already attempted';

    const observed = metricsFor(metrics, gateway.id);
    const successRate = (observed.success + Number(gateway.successRate) * 20) / (observed.total + 20);
    const responseTimeMs = observed.averageResponseTimeMs ?? gateway.responseTimeMs;
    const factors = {
      availability: gateway.health === 'HEALTHY' ? 1 : 0.5,
      successRate,
      responseTime: 1 / (1 + responseTimeMs / 500),
      priority: 1 / Math.max(1, priority),
    };
    const score = exclusion ? null : (
      weights.availability * factors.availability + weights.successRate * factors.successRate +
      weights.responseTime * factors.responseTime + weights.priority * factors.priority
    ) / weightTotal;
    return { gatewayId: gateway.id, name: gateway.name, score, exclusion, factors };
  });
  const eligible = candidates.filter(candidate => candidate.score !== null);
  eligible.sort((left, right) => right.score! - left.score!);
  const selected = eligible[0] ?? null;
  return {
    strategy: 'WEIGHTED',
    selectedGatewayId: selected?.gatewayId ?? null,
    reason: selected ? `${selected.name} had the highest eligible weighted score (${selected.score!.toFixed(3)}).`
      : 'No active and healthy gateway supports this payment and has attempts remaining.',
    candidates,
  };
}
