# Cold Storage Management System — Setup & Deployment (agora-be)

## Prerequisites
- Node.js ≥ 20
- MongoDB **replica set** (single node is fine — see below) — required because inventory & accounting operations use multi-document transactions.

### Enable transactions on a single-node MongoDB
Transactions need an oplog, so a standalone mongod must run as a single-member replica set:

```bash
mongod --replSet rs0 --dbpath ./data --bind_ip 127.0.0.1
# then once:
mongosh --eval 'rs.initiate()'
```

## Backend setup
```bash
cd agora-be
cp .env.example .env   # fill MONGODB_URI, JWT_ACCESS_SECRET (>=32 chars)
npm install
npm run dev            # tsx watch, port 4000
```

## Seed
```bash
npm run db:setup       # migrate users + seed + indexes + sanity
```
Or seed only what the cold module needs via the API (`POST /api/v1/ops/...`) once a cold user is assigned to a facility.

## Frontend setup
```bash
cd agora-fe
npm install
npm run dev            # Vite, usually http://localhost:5173
```
The frontend calls `VITE_API_URL` (default `http://localhost:4000/api/v1`).

## Environment variables (backend)
| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Mongo connection string (replica set) |
| `JWT_ACCESS_SECRET` | Access-token signing secret (≥32 chars) |
| `JWT_EXPIRES_IN` | e.g. `12h` |
| `NODE_ENV` | `development` / `test` / `production` |
| `PORT` | default `4000` |

## Tests
```bash
cd agora-be
npm test              # unit + cold integration (spins an in-memory Mongo replica set)
npm run lint
```

## Backups & restore
- Use `mongodump`/`mongorestore` on the replica set.
- Audit events (`AuditEvent`) and movement/genealogy/journal collections are append-only — restore the full DB to preserve the trail.
- Documented restore procedure: restore to a fresh replica set, run `db:indexes`, then sanity-check with `db:sanity`.
