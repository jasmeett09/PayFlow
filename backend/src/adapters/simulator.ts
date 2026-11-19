import { createHash } from 'node:crypto';
import type { PaymentScenario } from '@prisma/client';

export const gatewayCodes = ['gateway-a', 'gateway-b', 'gateway-c'] as const;
export type GatewayCode = (typeof gatewayCodes)[number];

type Request = {
  paymentId: string;
  sequence: number;
  scenario: PaymentScenario;
  baselineSuccessRate: number;
  baselineResponseTimeMs: number;
};

type Outcome = 'SUCCESS' | 'DECLINED' | 'UNAVAILABLE' | 'UNKNOWN';
type Result = { outcome: Outcome; reference: string; responseTimeMs: number };

export interface PaymentGateway {
  initiate(request: Request): Result;
  check(request: Request, verification: number): Outcome;
  refund(paymentReference: string): string;
}

function simulator(code: GatewayCode): PaymentGateway {
  return {
    initiate(request) {
      const reference = `${code}:${request.paymentId}:${request.sequence}`;
      const sample = createHash('sha256').update(reference).digest();
      const responseTimeMs = request.baselineResponseTimeMs + sample.readUInt8(4) % 50;
      let outcome: Outcome = 'SUCCESS';
      if (request.scenario === 'DECLINE') outcome = 'DECLINED';
      if (request.scenario === 'NORMAL' && sample.readUInt32BE() / 0x100000000 >= request.baselineSuccessRate) {
        outcome = 'UNAVAILABLE';
      }
      if (request.sequence === 1) {
        if (request.scenario === 'FAILOVER') outcome = 'UNAVAILABLE';
        if (request.scenario.startsWith('TIMEOUT_')) outcome = 'UNKNOWN';
      }
      return { outcome, reference, responseTimeMs: outcome === 'UNKNOWN' ? 1_500 : responseTimeMs };
    },
    check(request, verification) {
      if (request.scenario === 'TIMEOUT_UNKNOWN' || verification < 2) return 'UNKNOWN';
      if (request.scenario === 'TIMEOUT_SUCCESS') return 'SUCCESS';
      if (request.scenario === 'TIMEOUT_FAILOVER') return 'UNAVAILABLE';
      return 'UNKNOWN';
    },
    refund(paymentReference) {
      return `refund_${createHash('sha256').update(paymentReference).digest('hex')}`;
    },
  };
}

const adapters = {
  'gateway-a': simulator('gateway-a'),
  'gateway-b': simulator('gateway-b'),
  'gateway-c': simulator('gateway-c'),
};

export function gatewayAdapter(code: string) {
  if (!Object.hasOwn(adapters, code)) throw new Error('Gateway has no simulator');
  return adapters[code as GatewayCode];
}
