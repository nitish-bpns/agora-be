import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Device, GradingRecord, HardwareCatalogue, ImageRecord, Measurement } from './integration.models.js';
import { requireFacilityInOrg } from './scoping.js';

const AUDIT_REALM = 'Storage';

/* ------------------------------------------------------------------ */
/* Device registry                                                     */
/* ------------------------------------------------------------------ */

export async function registerDevice(input: {
  organizationId: string; facilityId?: string | null; locationId?: string | null;
  category: string; manufacturer?: string; model?: string; catalogueModelId?: string | null;
  serialNumber?: string; integrationType?: string; connectionMethod?: string;
  status?: string; config?: unknown; calibrationRef?: string; installationNotes?: string; supportedMeasurands?: string[];
}, actorId: string): Promise<object> {
  if (input.facilityId) await requireFacilityInOrg(input.organizationId, input.facilityId);
  // Phase 1: never allow a device created today to claim 'Connected' — no integration exists to prove it.
  const status = input.status && input.status !== 'Connected' ? input.status : 'Planned';
  const deviceId = await nextId('device');
  const device = await Device.create({
    deviceId, organizationId: input.organizationId, facilityId: input.facilityId ?? null, locationId: input.locationId ?? null,
    category: input.category, manufacturer: input.manufacturer ?? '', model: input.model ?? '',
    catalogueModelId: input.catalogueModelId ?? null, serialNumber: input.serialNumber ?? '',
    integrationType: input.integrationType ?? '', connectionMethod: input.connectionMethod ?? 'Other',
    status, enabled: true, config: input.config ?? {}, calibrationRef: input.calibrationRef ?? '',
    installationNotes: input.installationNotes ?? '', supportedMeasurands: input.supportedMeasurands ?? [], createdBy: actorId
  });
  await recordAudit({ realm: AUDIT_REALM, collection: 'devices', recordId: deviceId, action: 'Register', actorId, after: device.toObject() });
  return device.toObject();
}

export async function updateDeviceStatus(input: { organizationId: string; deviceId: string; status: string; lastError?: string }, actorId: string): Promise<object> {
  if (input.status === 'Connected') {
    throw new ApiError(409, 'A device can only be marked Connected by a real integration test (Phase 2)', 'CONNECTED_NOT_PROVEN');
  }
  const device = await Device.findOne({ deviceId: input.deviceId, organizationId: input.organizationId });
  if (!device) throw new ApiError(404, `Device ${input.deviceId} was not found`);
  const before = { status: device.status };
  device.status = input.status as typeof device.status;
  device.lastError = input.lastError ?? device.lastError;
  await device.save();
  await recordAudit({ realm: AUDIT_REALM, collection: 'devices', recordId: input.deviceId, action: 'UpdateStatus', actorId, before, after: { status: device.status } });
  return device.toObject();
}

export async function listDevices(input: { organizationId: string; facilityId?: string; category?: string; status?: string }): Promise<object[]> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.facilityId) filter.facilityId = input.facilityId;
  if (input.category) filter.category = input.category;
  if (input.status) filter.status = input.status;
  return Device.find(filter).sort({ createdAt: -1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Hardware catalogue                                                  */
/* ------------------------------------------------------------------ */

export async function addHardwareModel(input: {
  category: string; manufacturer: string; model: string; supportedMeasurands?: string[];
  communicationInterfaces?: string[]; requiredAdapter?: string; configurationOptions?: unknown;
  verificationStatus: string; integrationStatus?: string; documentationRefs?: string[]; knownLimitations?: string;
}): Promise<object> {
  const modelId = await nextId('catalogueModel');
  const record = await HardwareCatalogue.create({ modelId, ...input });
  return record.toObject();
}

export async function listHardwareModels(category?: string): Promise<object[]> {
  const filter = category ? { category } : {};
  return HardwareCatalogue.find(filter).sort({ manufacturer: 1, model: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Measurements (Phase 1: manual entry only; devices impossible)      */
/* ------------------------------------------------------------------ */

export async function addManualMeasurement(input: {
  organizationId: string; facilityId?: string | null; locationId?: string | null; lotId?: string | null;
  deviceId?: string | null; measurementType: string; value: number; unit: string;
  measuredAt?: string; operatorId?: string; notes?: string;
}, actorId: string): Promise<object> {
  if (input.deviceId) {
    const device = await Device.findOne({ deviceId: input.deviceId, organizationId: input.organizationId }).lean();
    if (!device) throw new ApiError(404, `Device ${input.deviceId} was not found`);
    if (device.status === 'Connected') throw new ApiError(409, 'Manual entry is not allowed for a connected device (use its integration)', 'DEVICE_CONNECTED');
  }
  const measurementId = await nextId('measurement');
  const measurement = await Measurement.create({
    measurementId, organizationId: input.organizationId, facilityId: input.facilityId ?? null, locationId: input.locationId ?? null,
    lotId: input.lotId ?? null, deviceId: input.deviceId ?? null, measurementType: input.measurementType,
    value: input.value, unit: input.unit, measuredAt: input.measuredAt ? new Date(input.measuredAt) : new Date(),
    dataSource: 'Manual', operatorId: actorId, quality: 'Good'
  });
  await recordAudit({ realm: AUDIT_REALM, collection: 'measurements', recordId: measurementId, action: 'ManualMeasurement', actorId, metadata: input });
  return measurement.toObject();
}

export async function listMeasurements(input: { organizationId: string; deviceId?: string; lotId?: string; measuredType?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.deviceId) filter.deviceId = input.deviceId;
  if (input.lotId) filter.lotId = input.lotId;
  if (input.measuredType) filter.measurementType = input.measuredType;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Measurement.find(filter).sort({ measuredAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Measurement.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

/* ------------------------------------------------------------------ */
/* Images & grading (Phase 1: manual upload + human review only)       */
/* ------------------------------------------------------------------ */

export async function attachImage(input: {
  organizationId: string; facilityId?: string | null; cameraId?: string | null; lotId?: string | null;
  url: string; capturedAt?: string; notes?: string;
}, actorId: string): Promise<object> {
  const imageId = await nextId('image');
  const image = await ImageRecord.create({
    imageId, organizationId: input.organizationId, facilityId: input.facilityId ?? null, cameraId: input.cameraId ?? null,
    lotId: input.lotId ?? null, url: input.url, capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
    capturedBy: actorId, notes: input.notes ?? ''
  });
  return image.toObject();
}

export async function createGradingRecord(input: {
  organizationId: string; facilityId?: string | null; lotId?: string | null; imageId?: string | null; humanGrade: string; notes?: string;
}, actorId: string): Promise<object> {
  const gradingId = await nextId('grading');
  const record = await GradingRecord.create({
    gradingId, organizationId: input.organizationId, facilityId: input.facilityId ?? null, lotId: input.lotId ?? null,
    imageId: input.imageId ?? null, humanGrade: input.humanGrade, status: 'Approved', reviewedBy: actorId,
    reviewedAt: new Date(), notes: input.notes ?? ''
    // aiModelVersion / predictedGrade intentionally left null — no AI in Phase 1.
  });
  await recordAudit({ realm: AUDIT_REALM, collection: 'gradings', recordId: gradingId, action: 'HumanGrade', actorId, metadata: input });
  return record.toObject();
}

/* ------------------------------------------------------------------ */
/* Integration contracts (Phase 2 adapter interfaces as data)          */
/* ------------------------------------------------------------------ */

export async function listIntegrationContracts(): Promise<object[]> {
  return [
    { id: 'MoistureMeterAdapter', capabilities: ['readMoisture', 'getStatus', 'testConnection', 'getMetadata'], phase: 2 },
    { id: 'EnvironmentalSensorAdapter', capabilities: ['readMeasurement', 'getStatus', 'testConnection', 'getMetadata', 'subscribe'], phase: 2 },
    { id: 'CameraAdapter', capabilities: ['captureImage', 'getStatus', 'testConnection', 'getMetadata'], phase: 2 },
    { id: 'VehicleTrackerAdapter', capabilities: ['getLocation', 'getStatus', 'testConnection', 'getMetadata'], phase: 2 }
  ];
}
