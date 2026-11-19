# PayFlow architecture

PayFlow simulates a payment orchestration system. The React dashboard calls a versioned Express API. Authentication resolves current merchant membership and role from PostgreSQL. The API exposes platform-wide analytics only through administrator routes.

## Payment lifecycle

| State | Allowed next states |
| --- | --- |
| CREATED | PROCESSING, CANCELLED |
| PROCESSING | SUCCESS, FAILED, PENDING, CANCELLED |
| PENDING | PROCESSING, SUCCESS, FAILED |
| SUCCESS | REFUNDED |
| FAILED, CANCELLED, REFUNDED | Terminal |

Payment creation serializes requests for the same merchant and idempotency key using a PostgreSQL transaction-scoped advisory lock. In one commit it writes the payment, its immutable 202 response, the audit entry, and a due timestamp. A unique database constraint enforces the merchant and key pair. The dashboard loads the current state from the detail endpoint.

BullMQ workers receive due IDs through Redis. PostgreSQL owns the schedule, so a worker can rediscover unprocessed work after a restart or Redis outage. Workers take a payment-specific transaction lock, recheck the due timestamp and current state, and record the resulting attempt, audit entry, and schedule together. BullMQ retries infrastructure errors. The payment processor controls business retry limits and exponential delays.

The three adapters are deterministic simulations. Their operations run within the database transaction because they perform local computations and never call a remote payment network. A real integration would need stable provider request keys and a durable handoff before making external calls.

## Routing

Merchant configuration controls gateway activation, priority, and relative weights. The candidate set may exclude system-inactive, unhealthy, incompatible, or previously attempted gateways. Availability maps healthy to 1 and degraded to 0.5. Success blends the gateway baseline with observed merchant outcomes. Latency scores use `1 / (1 + ms / 500)`. Priority scores use `1 / max(1, priority)`. The engine normalizes the weighted sum by the total weight and records all candidates, exclusions, factors, and the selected score.

A terminal decline fails immediately. A confirmed no-charge failure may advance to an eligible alternative. A timeout moves the payment to pending. The worker checks the original gateway before attempting failover. After the verification budget is exhausted, the payment remains pending and can be resolved by a signed gateway event.

## Webhooks and settlements

Webhook signatures authenticate the exact request bytes. Gateway and event ID form a unique key. The delivery count records redeliveries, while event and payment advisory locks prevent duplicate processing or conflicting lifecycle operations. Only a matching current gateway reference may advance an uncertain payment. Unmatched or stale events are retained as ignored. Failed processing may be retried using the same signed delivery or the scoped log action.

Successful payments generate simulated settlements. A full refund updates the corresponding generated settlement. Independently imported entries retain duplicates so reconciliation can report them. A reconciliation run reads a consistent PostgreSQL snapshot and reports missing records, amount or currency differences, status differences, and duplicate settlements.

## Data ownership and deployment

Merchant queries use the merchant ID resolved from the session. Composite foreign keys constrain payments, attempts, decisions, refunds, idempotency records, and settlement links to the correct workspace. The dashboard reports amounts per currency and only displays metrics from the API.

The backend runs the HTTP API and a BullMQ worker in one process. Use separate Redis instances for environments. Credential and operational rate limits are process-local. A multi-instance deployment needs a shared rate-limit store to enforce a single limit across replicas.
