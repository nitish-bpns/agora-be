# Architecture / Decision Records — Cold Storage Phase 1

## ADR-1: Extend existing monorepo instead of a new repo
**Context:** The workspace already contains `agora-be` (Express 5 + Mongoose 8, ESM, zod, JWT realm/role auth, audit ledger) and `agora-fe` (React 18 + Vite + TanStack Query).
**Decision:** Build the cold-storage system inside this monorepo as new modules, preserving the existing custody/exchange/broker/desk functionality untouched. New backend namespace: `/api/v1/ops/*`. New frontend section: `/ops/*`. Domain models are stored under `src/modules/warehouse/*` — a new Mongo database by default (`agora_cold`) to keep physical inventory logically separate from securities custody.
**Consequence:** existing tests must keep passing; new code must follow existing conventions (`.js` import suffixes, zod validation, `asyncHandler`, audit recording).

## ADR-2: MongoDB with transactional, ledger-based inventory/accounting
**Context:** Needs atomicity for inward/outward/split/merge/transfer and double-entry posting. The codebase is already Mongoose.
**Decision:** Use MongoDB replica-set transactions (already supported by mongoose 8) for all critical multi-write operations. Inventory balance is **not** an editable field; it is derived from an append-only `Movement` ledger (like the existing custody transfer model). Accounting uses an append-only `JournalEntry` with balance-checked postings; posted entries are never edited — only reversed.
**Consequence:** requires `retryWrites=true` and WiredTiger; single-node deployments need a local replica set (documented in setup).

## ADR-3: Multi-tenant isolation by organizationId + facilityId
**Context:** Phase 1 may deploy a single facility but must not hardcode it.
**Decision:** Every collection carries `organizationId` (required) and `facilityId` (optional where cross-facility). All service-layer queries filter by the caller's org; a facility manager sees only their facility's operational records. RBAC roles: `OrgAdmin`, `FacilityManager`, `InventoryOperator`, `AccountsOperator`, `GateOperator`, `Auditor` (read-only). Enforced server-side in services, not just UI.
**Consequence:** cross-facility transfers create records in both orgs' views; shares are explicit transfer documents, not global visibility.

## ADR-4: Lot identity & genealogy
**Context:** Must preserve lineage through splits/merges/transfers, and QR codes must be stable.
**Decision:** `lotNumber` is a permanent, unique business id (e.g. `LOT-00000001`), never reused. Splits create child lots referencing `parentLotId` and a `GenealogyEvent` (type split/merge/transfer/inward/outward/adjust) recording before/after quantities, reason, actor. Merges link all source lots to the merged lot and close the sources. Lot history can be traversed via genealogy events; QR encodes the lot number (stable) only — all mutable info comes from the API.

## ADR-5: Ownership vs custody vs location
**Context:** A commodity may change owner while staying in place, or move facilities while keeping ownership.
**Decision:** Separate concepts: `ownerId` (party who owns), `custodianFacilityId` (who physically holds), `locationId` (shed/chamber/slot). `OwnershipTransfer` events record owner changes historically. Splits/merges touching multiple owners require explicit allocation input (no silent pooling).

## ADR-6: Storage billing & accounting
**Context:** Rent formulas differ per facility; must not be hardcoded.
**Decision:** `ChargeType` + `BillingRule` (base: quantity/weight/bags/pallets/duration/contract; rate; free days; min period; rounding) are configurable per facility. Bills are generated as drafts, then posted; posting creates the AR journal entry atomically. Receipts/payments post to cash/bank + AR. Trial balance/P&L/balance sheet are computed from posted journal entries only.

## ADR-7: Offline-first sync
**Context:** Facilities must operate through outages; local-first with durable queue.
**Decision:** PWA (Vite + Workbox via `vite-plugin-pwa`) with IndexedDB local store. Mutable ops (inward/outward/gatepass/receipt) enqueue with a client-generated `clientOpId`; server endpoints are idempotent on `clientOpId` (unique index + "already applied" response). Conflicts: server returns `CONFLICT` with a server snapshot; client keeps the pending op, marks it conflicted, and surfaces a resolution UI. Financial/inventory balances are never considered authoritative on the client.

## ADR-8: Phase 2 hardware readiness
**Context:** Must support multiple moisture meters, temp/humidity sensors, cameras/AI grading, GPS trackers without rewriting core modules.
**Decision:** Define TypeScript interfaces `MoistureMeterAdapter`, `EnvironmentalSensorAdapter`, `CameraAdapter`, `VehicleTrackerAdapter` plus a `DeviceRegistry` (category, manufacturer/model from a configurable catalogue, connection status enum: Planned → Configured-not-connected → Connected → Offline → Error → Disabled). Measurement documents store provenance (device, type, value, unit, timestamps, calibration ref, quality). No fake connectivity; `Connected` only when a real integration confirms it (Phase 2). Catalog metadata flags verification status (tested / manufacturer-documented / unverified / unsupported).

## ADR-9: Only-online operations
Some operations that affect shared inventory/financial state across devices must stay online-only in Phase 1: inter-facility transfers (dispatch/receipt), posting bills, journal postings, and split/merge on lots touched by another pending op. Inward/outward/receipts on a single facility are queueable offline with idempotency.
