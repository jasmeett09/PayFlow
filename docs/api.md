# PayFlow API

Use the `/api/v1` prefix. Success responses wrap the resource in `data`. Errors wrap a stable code and human-readable message in `error`. Resources with pagination return `items`, `total`, `page`, and `limit`. Amounts use integer minor-unit strings and ISO-style three-letter currency codes.

| Access | Method | Route |
| --- | --- | --- |
| Public | GET | `/health` |
| Public | POST | `/auth/register`, `/auth/login` |
| Authenticated | GET | `/auth/me` |
| Merchant | POST | `/payments` |
| Merchant | GET | `/payments`, `/payments/:id` |
| Merchant | POST | `/payments/:id/cancel`, `/payments/:id/refund` |
| Merchant | GET | `/gateways`, `/gateways/:id/health` |
| Merchant | PATCH | `/gateways/:id` |
| Merchant | GET/PATCH | `/routing/config` |
| Merchant | POST | `/routing/preview` |
| Merchant | GET | `/routing/decisions` |
| Signed gateway | POST | `/webhooks/:gateway` |
| Merchant | GET | `/webhooks` |
| Merchant | POST | `/webhooks/:id/retry` |
| Merchant | POST | `/reconciliation/settlements`, `/reconciliation/run` |
| Merchant | GET | `/reconciliation/reports`, `/reconciliation/reports/:id` |
| Merchant | GET | `/analytics/overview`, `/analytics/gateways`, `/analytics/transactions` |
| Merchant | GET/PATCH | `/settings` |
| Administrator | GET | `/admin/analytics/overview`, `/admin/analytics/gateways`, `/admin/analytics/transactions` |
| Administrator | PATCH | `/admin/gateways/:gateway` |

## Authentication and tenant scope

Send `Authorization: Bearer <accessToken>` on protected requests. Register with `merchantName`, `email`, and `password`. Log in with `email` and `password`. Tokens expire after 15 minutes. The server loads the database identity and current role for each protected request. Cross-merchant resource lookups return 404.

## Payments

Send a new `Idempotency-Key` with each intended payment. A payment request takes `amountMinor`, `currency`, `paymentMethod`, optional `merchantReference`, and optional `scenario`.

```json
{
  "amountMinor": "12500",
  "currency": "USD",
  "paymentMethod": "CARD",
  "merchantReference": "example-order",
  "scenario": "FAILOVER"
}
```

Creation returns HTTP 202 and the original CREATED snapshot, including on identical key replays. A different request using the same merchant key returns HTTP 409. The `Idempotency-Replayed` header identifies a replay. Retrieve the current state from `GET /payments/:id`, which includes attempts, routing decisions, refunds, and audit history. A full refund is supported after success. Cancel while created or processing before a charge succeeds or becomes uncertain.

Payment methods are `CARD`, `UPI`, `BANK_TRANSFER`, and `WALLET`. Simulator scenarios are `NORMAL`, `DECLINE`, `FAILOVER`, `TIMEOUT_SUCCESS`, `TIMEOUT_UNKNOWN`, and `TIMEOUT_FAILOVER`.

The ledger supports `search` (full ID or merchant reference text), `status`, `method`, `gateway` (code), `from`, `to`, `sort`, `page`, and `limit`. Dates are ISO timestamps with an inclusive start and exclusive end. Sort options are `newest`, `oldest`, `amount-high`, and `amount-low`.

## Gateways and routing

Merchant gateway updates support `active` and `priority`. Administrators can set globally simulated `health` and optional `active` by gateway code. Routing configuration accepts `availability`, `successRate`, `responseTime`, and `priority` weights from 0 to 100, with at least one nonzero value. Preview accepts `paymentMethod` and `amountMinor`. The weighting policy uses method and eligibility, so amount does not affect the score.

## Webhooks

Deliver JSON containing `eventId`, `type`, and `gatewayReference` to the gateway's route. Set `X-PayFlow-Signature` to the hex HMAC-SHA256 of the exact JSON bytes, using the gateway's configured signing secret. The event identifier is scoped to the gateway. Identical redelivery increments the delivery count and preserves the applied decision. Failed processing can be retried up to five times.

## Settlements and analytics

Successful payments automatically generate simulated settlement rows. Refunds update the generated row. A settlement import accepts `gateway`, `gatewayReference`, `amountMinor`, `currency`, `status`, and `settledAt`. Reconciliation takes `from` and `to` timestamps and compares payment creation and settlement timestamps against that interval. Use a window of up to 93 days and at most 10,000 entries per source.

Analytics accepts the same status, method, gateway, and date filters as the ledger. Volume is grouped by currency and includes requested transaction amounts. Successful outcomes include previously successful refunded payments. Success and failure rates use resolved successful and failed outcomes. Pending metrics count created, processing, and pending items. The daily trend endpoint covers up to 31 days of the requested interval.
