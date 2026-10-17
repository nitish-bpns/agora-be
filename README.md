# Agora Backend

A strict TypeScript/Express/MongoDB migration of the legacy Agora desk, broker, exchange and custody applications. The deployment is a modular monolith; module boundaries preserve the original service ownership rules.

## Modules

- `desk`: trades, tickets, orders, weighted-average positions, P&L, cash, prices, reports and broker feed booking
- `broker`: separate trader identity, sessions, routing, exchange replicas, attribution, enlistments and settlement replicas
- `exchange`: mandis, instruments, listings, members, price-time matching, executions and bilateral settlement
- `storage`: vault inventory, physical lots and append-only ownership transfers
- `auth` / `audit`: realm-separated operators, RBAC and field-level history

## Setup

1. Copy values into `.env`. Set `MONGODB_URI` to the MongoDB deployment to use and replace the JWT placeholder secret.
2. Run `npm install`.
3. Run `npm run seed` explicitly. This idempotently creates the standard Trader, Broker, Exchange, and Storage users. Demo market data is created only when `SEED_DEMO_DATA=true`.
4. Run `npm run dev`.

The unified `POST /api/v1/auth/login` endpoint identifies the stored user type from the username and returns the matching realm. User credentials are stored in MongoDB with bcrypt password hashes; they are not environment variables.

MongoDB transactions are used for matching and settlement, so production MongoDB must be a replica set (Atlas and standard production clusters satisfy this requirement).

## Commands

- `npm run dev` – development server
- `npm run build` – strict TypeScript build
- `npm test` – unit/acceptance tests
- `npm run seed` – idempotent bootstrap
