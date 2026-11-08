# Phase 2/3/4 Roadmap & Known Issues

## Phase 4 (shipped) — stock pledging & financer match-making

Shipped in November 2026. Customers can pledge their stored stock as security for loans; external financers review and fund applications through the platform.

| Area | What ships | Endpoints |
|---|---|---|
| Financer registry (central) | Banks / NBFCs / cooperatives / private lenders with lending policy (rates, LTV caps, tenure) | `GET/POST/PATCH /api/v1/ops/pledge/financers` |
| Financer accounts | Login per financer (realm `Financer`, linked via `financerId`) | `POST /api/v1/ops/network/financer-accounts` |
| Pledge applications (customer) | Apply against owned lots: quantity, stock value, requested amount, optional financer | `GET/POST /api/v1/customer/pledge/applications` |
| Financer reactions | Approve (creates pledge, enforces LTV) or reject | `POST /api/v1/financer/pledge/applications/:id/react` |
| Pledges & repayment | Disbursement ledger, interest accrual, repayments (principal+interest), stock release | `GET /api/v1/{ops,customer,financer}/pledge/pledges`, `/accrue`, `/repay`, `/release` |
| Central pledge book | All applications + pledges across the network | `GET /api/v1/ops/pledge/applications`, `/pledges` |

**Demo logins** (password `demo-pass-2026`): `financer1@agora.com` (Agri Finance Bank, FIN-00000001), `customer1@agora.com` (borrower).

**Phase 4 notes & limits**
- Interest is simple interest, accrued daily by explicit `/accrue` call (no background job yet).
- Pledging does not yet mark the lot as pledged (lot `status` is unchanged); a `pledgedQuantity` ledger per lot is the intended guard (Phase 4.5).
- No credit-scoring, collateral valuation model, or statutory lending docs yet.

## Phase 3 (shipped) — customer terminal, employee terminal, finance depth

Shipped in November 2026. New surfaces and endpoints:

| Area | What ships | Endpoints |
|---|---|---|
| Customer (depositor) terminal | `User` type `Customer` linked to a `Party`; sees stock across ALL facilities, live environment, loading events, bills/receipts, cameras | `GET /api/v1/customer/stock`, `/environment`, `/loading`, `/finance`, `/cameras` |
| Employee terminal | `User` type `Employee` scoped to one facility; live temperature, today's/yesterday's loading, fleet | `GET /api/v1/employee/environment`, `/today`, `/yesterday`, `/fleet` |
| Owner-side account mgmt | Central admin creates customer + employee logins | `POST /api/v1/ops/network/customer-accounts`, `/employee-accounts` |
| Cash flow statement | Operating / investing / financing from posted journals | `GET /api/v1/ops/cashflow` |
| Party ledger | Per-party running balance | `GET /api/v1/ops/ledger?partyId=…` |
| Day book | Chronological journal register | `GET /api/v1/ops/daybook` |
| GST summary | Output vs input tax, net payable | `GET /api/v1/ops/gst` |
| Consolidated books | All-org P&L / position / outstanding (central manager) | `GET /api/v1/ops/consolidated` |

**Demo logins** (password `demo-pass-2026`): `customer1@agora.com` (customer), `employee1@agora.com` (employee).

**Phase 3 notes & limits**
- Camera streams are surfaced as device registry entries; live video requires Phase 2 hardware connectivity.
- Employee access is facility-scoped by the `facilityId` claim; per-employee role matrix (gate/auditor/etc.) builds on the existing cold role model.
- Customer accounts are linked to one Party; multiple parties per customer login is not yet modeled.

## Phase 2 roadmap (architecture already prepared in Phase 1)

| Area | Phase 1 (done) | Phase 2 (future) |
|---|---|---|
| Moisture meters | Device registry, catalogue, manual readings, `MoistureMeterAdapter` contract | Real adapters (Bluetooth/USB/serial/API), auto-ingestion, calibration workflows |
| Environmental sensors | Sensor registry, threshold fields, measurement schema, empty-state monitoring UI | MQTT/Modbus/HTTPS ingestion, stale-reading detection, alerts + acknowledgements, charts |
| Cameras / AI grading | Manual image attach, human-approved grades, `CameraAdapter` contract | Camera capture, model training/inference, predicted grade + confidence, human review/override, model versioning |
| GPS trackers | Vehicle tracker status enum, trips work without tracker, `VehicleTrackerAdapter` contract | Provider-neutral live location, ETA, geofencing, provider status/error handling |
| Network | Multi-org/facility isolation, inter-facility transfers | Cross-org sharing contracts, network-wide traceability |
| Accounting/ERP | Double-entry, statements, exports-ready | External accounting/ERP connectors, statutory filings (requires validation) |
| Offline | Idempotent ops (`clientOpId`), queue-ready API | Full PWA offline queue + conflict-resolution UI, sync status indicators |

## Known issues & limitations (Phase 1)
1. **Transactions require a replica set** — single-node deployments must run `mongod --replSet rs0` (documented in SETUP.md).
2. **Offline-first is API-ready, not client-complete** — the backend accepts `clientOpId` for idempotency and rejects duplicates, but the PWA offline queue + conflict-resolution UI is not yet shipped (Milestone 5 partial).
3. **Capacity utilization** uses lot `currentQuantity` as kg proxy; precise weight-based capacity needs unit conversion wiring per lot (conversion helper exists in `master.service.tryConvert`).
4. **Billing rent formulas** support quantity/bags/pallets/duration/contract bases with free days, min period, partial-day and rounding rules; complex slab/contract formulas beyond the documented `ruleConfig` shape need confirmation.
5. **No live hardware connectivity** — by design; `Connected` status is blocked until a real integration exists.
6. **Financial statements** are computed from posted journals; bank reconciliation UI is not yet built (schema supports it).
7. **QR/barcode generation & scanning** — lot numbers are stable and QR-encodable, and a lookup endpoint exists (`/ops/lots/lookup/:lotNumber`); client-side QR rendering/scanner is not yet wired.
8. **XLSX/PDF exports** — reporting endpoints return structured data; export serializers are not yet implemented.
9. **Audit service fix** — `recordAudit` now generates ids sequentially (was racing on the shared counter for multi-field changes); existing behavior otherwise unchanged.

## Unresolved business decisions (need confirmation)
- Free-days / minimum-billing-period defaults per facility (configurable via `ChargeType`).
- Partial-day rent treatment (default `chargeFullDay`).
- Whether moisture % maps to a grade (default: no — requires explicit grading rules).
- Cross-facility transfer discrepancy handling (default: received-with-discrepancy + damage qty recorded, no auto-adjustment).
- Operator-owned inventory billing rules (default: same charge types apply).