import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { coldAuth, coldFacilityRequired, coldRoleGuard } from './cold.middleware.js';
import {
  addHardwareModel, addManualMeasurement, attachImage, createGradingRecord,
  listDevices, listHardwareModels, listIntegrationContracts, listMeasurements,
  registerDevice, updateDeviceStatus
} from './integration.service.js';

export const coldIntegrationRouter = Router();
coldIntegrationRouter.use(coldAuth);

/* Device registry */
coldIntegrationRouter.get('/devices', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().optional(), category: z.string().optional(), status: z.string().optional() }), req.query as Record<string, unknown>);
  res.json({ items: await listDevices({ organizationId: req.cold!.organizationIds[0]!, facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined, category: query.category, status: query.status }) });
}));
coldIntegrationRouter.post('/devices', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    facilityId: z.string().optional().nullable(), locationId: z.string().optional().nullable(),
    category: z.enum(['MoistureMeter', 'EnvironmentalSensor', 'Camera', 'VehicleTracker', 'Other']),
    manufacturer: z.string().optional(), model: z.string().optional(), catalogueModelId: z.string().optional().nullable(),
    serialNumber: z.string().optional(), integrationType: z.string().optional(),
    connectionMethod: z.string().optional(), status: z.string().optional(), config: z.unknown().optional(),
    calibrationRef: z.string().optional(), installationNotes: z.string().optional(), supportedMeasurands: z.array(z.string()).optional()
  }), req.body);
  res.status(201).json(await registerDevice({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId, ...body }, req.auth!.subject));
}));
coldIntegrationRouter.post('/devices/:deviceId/status', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['Planned', 'ConfiguredNotConnected', 'TemporarilyOffline', 'Error', 'Disabled']), lastError: z.string().optional() }), req.body);
  res.json(await updateDeviceStatus({ organizationId: req.cold!.organizationIds[0]!, deviceId: String(req.params.deviceId ?? ''), status: body.status, lastError: body.lastError }, req.auth!.subject));
}));

/* Hardware catalogue */
coldIntegrationRouter.get('/hardware', asyncHandler(async (req, res) => {
  const query = parse(z.object({ category: z.string().optional() }), req.query as Record<string, unknown>);
  res.json({ items: await listHardwareModels(query.category) });
}));
coldIntegrationRouter.post('/hardware', coldRoleGuard('OrgAdmin'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    category: z.enum(['MoistureMeter', 'EnvironmentalSensor', 'Camera', 'VehicleTracker', 'Other']),
    manufacturer: z.string().min(1), model: z.string().min(1), supportedMeasurands: z.array(z.string()).optional(),
    communicationInterfaces: z.array(z.string()).optional(), requiredAdapter: z.string().optional(),
    configurationOptions: z.unknown().optional(), verificationStatus: z.enum(['VerifiedByTesting', 'ManufacturerDocumented', 'NotYetVerified', 'Unsupported']),
    integrationStatus: z.string().optional(), documentationRefs: z.array(z.string()).optional(), knownLimitations: z.string().optional()
  }), req.body);
  res.status(201).json(await addHardwareModel(body));
}));

/* Integration contracts (Phase 2 adapter registry metadata) */
coldIntegrationRouter.get('/contracts', asyncHandler(async (_req, res) => {
  res.json({ items: await listIntegrationContracts() });
}));

/* Measurements (manual entry allowed for planned/configured devices) */
coldIntegrationRouter.get('/measurements', asyncHandler(async (req, res) => {
  const query = parse(z.object({ deviceId: z.string().optional(), lotId: z.string().optional(), measuredType: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listMeasurements({ organizationId: req.cold!.organizationIds[0]!, deviceId: query.deviceId, lotId: query.lotId, measuredType: query.measuredType, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));
coldIntegrationRouter.post('/measurements', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    locationId: z.string().optional().nullable(), lotId: z.string().optional().nullable(), deviceId: z.string().optional().nullable(),
    measurementType: z.enum(['Temperature', 'RelativeHumidity', 'MoisturePct', 'DewPoint', 'Pressure', 'Other']),
    value: z.number(), unit: z.string().min(1), measuredAt: z.string().optional()
  }), req.body);
  res.status(201).json(await addManualMeasurement({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject));
}));

/* Images & human grading (Phase 1: no AI) */
coldIntegrationRouter.post('/images', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ cameraId: z.string().optional().nullable(), lotId: z.string().optional().nullable(), url: z.string().min(1), capturedAt: z.string().optional(), notes: z.string().optional() }), req.body);
  res.status(201).json(await attachImage({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject));
}));
coldIntegrationRouter.post('/gradings', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ lotId: z.string().optional().nullable(), imageId: z.string().optional().nullable(), humanGrade: z.string().min(1), notes: z.string().optional() }), req.body);
  res.status(201).json(await createGradingRecord({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject));
}));
