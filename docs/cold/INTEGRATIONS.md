# Hardware Integration Architecture (Phase 2 readiness)

## Principle
Phase 1 ships the **contracts, registry, configuration UI, and measurement schema** for future hardware. No adapter in Phase 1 performs device communication, and **no device can become `Connected` without a real integration test** (enforced in `integration.service.ts`).

## Device lifecycle
`Planned → ConfiguredNotConnected → (Connected | TemporarilyOffline | Error) → Disabled`

- `registerDevice` stores the intended configuration; status defaults to `Planned`.
- `updateDeviceStatus` **rejects `Connected`** — a future Phase 2 adapter must set it only after a successful real connection test.
- `addManualMeasurement` refuses to write manual readings against a device already marked `Connected`.

## Adapter contracts (TypeScript, documented in `listIntegrationContracts()`)
| Interface | Capabilities (phase 2) |
|---|---|
| `MoistureMeterAdapter` | `readMoisture`, `getStatus`, `testConnection`, `getMetadata` |
| `EnvironmentalSensorAdapter` | `readMeasurement`, `subscribe`, `getStatus`, `testConnection`, `getMetadata` |
| `CameraAdapter` | `captureImage`, `getStatus`, `testConnection`, `getMetadata` |
| `VehicleTrackerAdapter` | `getLocation`, `getStatus`, `testConnection`, `getMetadata` |

Future implementations must talk through these application-level interfaces; vendor logic lives in adapters only, never in inventory/accounting modules.

## Adding a new hardware model (developer guide)
1. Add a catalogue entry via `POST /api/v1/ops/hardware` (category, manufacturer, model, measurands, interfaces, verification status). This is config data — no code change needed.
2. If no adapter exists yet: implement the matching `*Adapter` interface in a new file under `src/modules/warehouse/adapters/` and register it in the adapter registry (`listIntegrationContracts`).
3. Attach the adapter id to a `Device` record via `integrationType`. Keep `status` in `ConfiguredNotConnected` until the adapter's `testConnection` genuinely succeeds.
4. Never fabricate readings, GPS coordinates, or connectivity state.

## Measurement schema
`Measurement` records device reference, measurement type, value, unit, measured-at vs ingested-at, organization/facility/location/lot, data source (device vs manual), quality, calibration ref, and original payload. Historical readings are never rewritten on recalibration.

## Camera & AI grading
Phase 1 supports manual image attachment (`ImageRecord`) and human-approved grades (`GradingRecord`, `aiModelVersion`/`predictedGrade` stay null). Final grade approval remains a human-controlled workflow.
