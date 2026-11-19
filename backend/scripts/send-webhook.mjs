import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';

const keys = { 'gateway-a': 'WEBHOOK_SECRET_A', 'gateway-b': 'WEBHOOK_SECRET_B', 'gateway-c': 'WEBHOOK_SECRET_C' };
const types = ['PAYMENT_SUCCESSFUL', 'PAYMENT_FAILED', 'PAYMENT_PENDING', 'REFUND_COMPLETED'];
const [gateway, type, gatewayReference, eventId = randomUUID()] = process.argv.slice(2);

async function main() {
  if (!Object.hasOwn(keys, gateway) || !types.includes(type) || !gatewayReference || !eventId) {
    throw new Error('Usage: npm run webhook:send -- <gateway-a|gateway-b|gateway-c> <EVENT_TYPE> <gateway-reference> [event-id]');
  }
  const secret = process.env[keys[gateway]];
  if (!secret) throw new Error('Configure ' + keys[gateway] + ' in the backend environment');
  const origin = process.env.PAYFLOW_API_ORIGIN ?? 'http://127.0.0.1:' + (process.env.PORT ?? '4000');
  const body = JSON.stringify({ eventId, type, gatewayReference });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  const response = await fetch(new URL('/api/v1/webhooks/' + gateway, origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PayFlow-Signature': signature },
    body, signal: AbortSignal.timeout(15000),
  });
  console.log(response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
