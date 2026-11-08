# Cold Storage Management System — Phase 1/3 PRD (short form)

## Purpose
A production-usable cold-storage facility management system: inventory (lots in/out, splits/merges, transfers), storage-location capacity, ownership/custody tracking, storage billing, double-entry accounting, vehicles/trips, gatepasses, reports, offline-first sync, and a Phase-2-ready hardware integration framework (moisture meters, environmental sensors, cameras/AI grading, GPS trackers). Phase 3 adds depositor (customer) and employee self-service terminals plus cash-flow/ledger/GST/consolidated accounting.

## Scope (Phase 1 build)
- Multi-organization, multi-facility hierarchy with facility-scoped records and RBAC.
- Master data: commodities, commodity varieties, units (bags/kg/MT/pallets with explicit conversions), packaging, storage locations (shed → chamber → rack/slot), pallets, parties (customers, farmers, traders, suppliers), employees, vehicles/drivers.
- Inventory ledger (append-only movements), inward, outward, internal relocation, adjustments with authorization + reason, lot split/merge with genealogy, ownership & custody history.
- Storage billing (configurable charge types: storage/rent, handling, loading, transport, materials; quantity/bags/pallets/duration bases), receipts, payments, customer statements, outstanding balances.
- Double-entry accounting: chart of accounts, journal, GL, trial balance, P&L, balance sheet, cash/bank, AR/AP, financial periods, controlled reversals.
- Gatepasses, inter-facility transfers, trips (work without trackers), vehicles with tracker availability status.
- QR/barcode identifiers for lots/pallets; manual fallback search.
- Device registry + adapter interfaces (Phase 2 contracts) — no fake connectivity; planned/configured states only.
- Empty-state env-monitoring and AI-grading sections.
- XLSX/PDF exports; offline-first queue with idempotent sync.
- Dashboards reconciling real data.

## Scope (Phase 3 build)
- **Customer / depositor terminal** (`User` type `Customer`, realm `Customer`): linked to a `Party` via `partyId`; sees stock, live environment, loading events, bills/payments and cameras **across all facilities**.
- **Employee terminal** (`User` type `Employee`, realm `Employee`): scoped to one facility via `facilityId`; live temperature, today's/yesterday's loading plan, fleet & trips.
- **Owner-side account management**: central admin creates customer and employee logins by email (by Party and by facility).
- **Finance depth**: cash flow statement, party ledger, day book, GST summary, consolidated multi-org statements. All computed from the same posted-journal ledger.

## Out of scope (Phase 2, architecture prepared)
Live sensor ingestion, MQTT/Modbus, real GPS tracking, AI inference/training, automated alerts from hardware, manufacturer adapters beyond contracts, cross-network features, statutory filings.

## Guiding rules
- Inventory and accounts are derived from validated, auditable ledgers; no free-editing of balances.
- Critical ops are atomic (MongoDB transactions), idempotent, and guarded against negative stock / double-spend.
- Never fabricate hardware readings, GPS, connectivity, or sync success.
- Unresolved business rules → documented assumption + configurable toggle + flag for confirmation.
