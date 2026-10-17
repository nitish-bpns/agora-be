# Agora Backend

A strict TypeScript/Express/MongoDB migration of the legacy Agora desk, broker, exchange and custody applications. The deployment is a modular monolith; module boundaries preserve the original service ownership rules.

## Modules

- `desk`: trades, tickets, orders, weighted-average positions, P&L, cash, prices, reports and broker feed booking
- `broker`: trader lifecycle, routing, exchange replicas, attribution, enlistments and settlement replicas
- `exchange`: mandis, instruments, listings, members, price-time matching, executions and bilateral settlement
- `storage`: vault inventory, physical lots and append-only ownership transfers
- `auth` / `audit`: one normalized users collection, user-type RBAC, hashed sessions and field-level history

## Setup

1. Copy values into `.env`. Set `MONGODB_URI`, replace the JWT placeholder secret, and set a temporary `BOOTSTRAP_USER_PASSWORD` used only by the seed command.
2. Run `npm install`.
3. Run `npm run db:setup` explicitly. This migrates legacy identities, creates the standard users, synchronizes all indexes, and runs database integrity checks. Demo market data is created only when `SEED_DEMO_DATA=true`.
4. Run `npm run dev`.

The unified `POST /api/v1/auth/login` endpoint identifies the stored user type from the username and returns the matching realm. User credentials are stored in MongoDB with bcrypt password hashes; they are not environment variables.

All Trader, Broker, Exchange, and Storage identities live in the `users` collection. `userType`, `role`, and `status` provide authorization and lifecycle discrimination. Trader-only fields such as `accountId` are optional and validated for Trader users; domain records retain `traderId` references to the user's stable `userId`. Opaque sessions live separately in `usersessions`, reference `userId`, store only token hashes, and expire through a MongoDB TTL index.

For databases created before identity normalization, run `npm run migrate:users` once. Use `npm run verify:users` to confirm that legacy `operators`, `traders`, and `tradersessions` collections no longer exist.

MongoDB transactions are used for matching and settlement, so production MongoDB must be a replica set (Atlas and standard production clusters satisfy this requirement).

## Vercel deployment

The serverless entrypoint is `api/index.ts`, with all incoming paths rewritten to it by `vercel.json`. Configure `MONGODB_URI`, `JWT_ACCESS_SECRET`, `JWT_EXPIRES_IN`, `NODE_ENV`, and `LOG_LEVEL` in the Vercel project environment.

Run `npm run db:setup` against the production MongoDB deployment once before serving production traffic. Vercel builds fail early when `MONGODB_URI` or `JWT_ACCESS_SECRET` is missing.

The API intentionally accepts requests from every public IP and browser origin. CORS returns `Access-Control-Allow-Origin: *`; authentication and role authorization still protect non-public endpoints.

## Commands

- `npm run dev` – development server
- `npm run build` – strict TypeScript build
- `npm test` – unit/acceptance tests
- `npm run seed` – idempotent bootstrap
- `npm run db:indexes` – synchronize declared MongoDB indexes
- `npm run db:sanity` – validate users, indexes, references, and settlement invariants
- `npm run db:setup` – migration, seed, indexes, and sanity in deployment order
