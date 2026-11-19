# PayFlow

PayFlow is a full-stack payment orchestration simulator. Create synthetic transactions, compare how three gateways are scored, follow retries and status checks, and reconcile payments with simulated settlements. The app uses React and Vite, Express and TypeScript, PostgreSQL and Prisma, and a Redis-backed BullMQ worker.

## Run locally

Use Node.js 22.12+, PostgreSQL, and a Redis server supported by BullMQ. Local installations and hosted database URLs both work. Use separate databases and Redis instances for development and production.

If you need local PostgreSQL databases, connect as an administrator with `psql -h 127.0.0.1 -U postgres -d postgres`. Create the role and set its password interactively.

```sql
CREATE ROLE payflow LOGIN;
\password payflow
CREATE DATABASE payflow OWNER payflow;
CREATE DATABASE payflow_test OWNER payflow;
\q
```

In a terminal at the repository root, open the backend and install dependencies.

```sh
cd backend
npm install
```

Copy `.env.example` to `.env` inside `backend`. Set `DATABASE_URL`, `REDIS_URL`, and `JWT_SECRET`. Generate a separate secret for each webhook signer you intend to use. Repeat this command to generate each value.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run db:deploy
npm run dev
```

Use a URL-encoded password in the PostgreSQL connection string. The API listens on `http://127.0.0.1:4000`. Check `/api/v1/health` for PostgreSQL and worker readiness.

In a second terminal at the repository root, start the frontend.

```sh
cd frontend
npm install
npm run dev
```

Open the **Local** URL printed by Vite and register a merchant workspace. Create a payment from **Transactions**. Choose **Retryable gateway failure** for a repeatable failover demo or **Timeout, awaiting webhook** to observe a payment that remains pending.

Vite starts at port 5173 and automatically tries the next available port if it is busy. The local frontend proxies API requests to the backend on port 4000. If your backend uses a different address, set `PAYFLOW_DEV_API_ORIGIN` in `frontend/.env`. Leave `VITE_API_URL` unset to use the local proxy.

### Send a simulated webhook

Start the backend with the secret corresponding to the selected gateway. Copy the gateway code and reference from the pending transaction, then run this command from `backend` with those values.

```sh
npm run webhook:send -- gateway-a PAYMENT_SUCCESSFUL "gateway-a:PAYMENT_UUID:1" demo-event-1
```

Run the identical command again to see the delivery count increase without reapplying the payment transition. Supported events are `PAYMENT_SUCCESSFUL`, `PAYMENT_FAILED`, `PAYMENT_PENDING`, and `REFUND_COMPLETED`. The sender reads the per-gateway signing secret from the backend environment. Set `PAYFLOW_API_ORIGIN` for a different API host.

### Provision an administrator

Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in the backend environment and run `npm run db:seed` from `backend`. The seed command provisions an administrator and an audit entry. Existing merchant logins keep their role. The administrator can access cross-workspace analytics and update simulator health through the admin API.

## Environment variables

| Scope | Variable | Purpose |
| --- | --- | --- |
| Backend | `DATABASE_URL` | PostgreSQL connection URL. |
| Backend | `JWT_SECRET` | Independent secret of at least 32 bytes. Generate a random value. |
| Backend | `REDIS_URL` | Redis connection URL, including `rediss://` for TLS if required. Defaults to local port 6379. Use a BullMQ-compatible Redis instance with a no-eviction policy. |
| Backend | `WEBHOOK_SECRET_A`, `WEBHOOK_SECRET_B`, `WEBHOOK_SECRET_C` | Independent simulated gateway signing secrets of at least 32 bytes. Required to receive signed events for the respective gateway. |
| Backend | `HOST`, `PORT`, `CORS_ORIGIN` | HTTP bind address, port, and allowed frontend origin. Defaults are `127.0.0.1`, `4000`, and `http://localhost:5173`. |
| Backend | `TRUST_PROXY_HOPS`, `LOG_LEVEL` | Proxy hop count for IP-based rate limiting and log level. Defaults are `0` and `info`. Configure trusted hops for the actual deployment topology. |
| Backend | `PAYMENT_MAX_ATTEMPTS`, `PAYMENT_MAX_VERIFICATIONS`, `PAYMENT_BACKOFF_MS` | Maximum distinct gateway attempts, status checks for an uncertain attempt, and base backoff delay. Defaults are `3`, `4`, and `750`. |
| Backend | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Optional administrator seed inputs. |
| Tests | `TEST_DATABASE_URL`, `TEST_REDIS_URL` | Dedicated PostgreSQL test database and optional real Redis worker test connection. |
| Frontend | `PAYFLOW_DEV_API_ORIGIN` | Local Vite proxy target. Defaults to `http://127.0.0.1:4000`. |
| Frontend | `VITE_API_URL` | Public API base for hosted builds, including `/api/v1`. The local default uses the same-origin proxy. |

## Verify

Inside `backend`, set `TEST_DATABASE_URL` to a database where the test role can create schemas. The tests apply both migrations to isolated schemas and remove those schemas after the run. Provide `TEST_REDIS_URL` to include the real queue and worker test.

```sh
npm run db:validate
npm run typecheck
npm run build
npm test
```

Inside `frontend`, run `npm run build`. Use `npm run preview` to serve the compiled dashboard locally.

## Deploy

- **Render backend.** Create a Node web service with root directory `backend`. Build with `npm ci --include=dev && npm run build`. Apply `npm run db:deploy` as a pre-deploy command or as a separate release step before starting the new build. Start with `npm start`. Set `HOST=0.0.0.0` and let Render supply `PORT`. Set the HTTP health-check path to `/api/v1/health`. Configure the database, Redis, secrets, and the deployed frontend origin in Render. [Render Express guide](https://render.com/docs/deploy-node-express-app)
- **Vercel frontend.** Use root directory `frontend` and the Vite preset. Build with `npm run build` and output directory `dist`. Set `VITE_API_URL` to the HTTPS Render API URL ending in `/api/v1`. The included rewrite supports direct visits to client-side routes. [Vercel Vite guide](https://vercel.com/docs/frameworks/frontend/vite)

See the [API reference](docs/api.md), [Postman collection](docs/PayFlow.postman_collection.json), and [architecture](docs/architecture.md).
