import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { coldAuth, coldFacilityRequired, coldRoleGuard } from './cold.middleware.js';
import { getLotByNumber, getLotProfile, listLots, recordInward, recordOutward, relocateLot, splitLot, mergeLots, transferOwnership, adjustLot, capacityOverview } from './inventory.service.js';
import { createGatepass, completeGatepass, listGatepasses, openGatepass, createTransfer, dispatchTransfer, receiveTransfer, listTransfers, createTrip, listTrips, updateTripStatus } from './operations.service.js';

export const coldInventoryRouter = Router();
coldInventoryRouter.use(coldAuth);

/* Dashboard + capacity */
coldInventoryRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const query = parse(z.object({ since: z.string().optional() }), req.query as Record<string, unknown>);
  const { buildDashboard } = await import('./dashboard.service.js');
  res.json(await buildDashboard({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId, since: query.since }));
}));
coldInventoryRouter.get('/capacity', coldFacilityRequired, asyncHandler(async (req, res) => {
  res.json(await capacityOverview(req.cold!.facilityId!));
}));

/* Lots */
coldInventoryRouter.get('/lots', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().optional(), ownerId: z.string().optional(), commodityId: z.string().optional(), status: z.string().optional(), lotNumber: z.string().optional(), search: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listLots({
    organizationId: req.cold!.organizationIds[0]!,
    facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined,
    ownerId: query.ownerId, commodityId: query.commodityId, status: query.status, lotNumber: query.lotNumber, search: query.search,
    page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined
  }));
}));
coldInventoryRouter.get('/lots/lookup/:lotNumber', asyncHandler(async (req, res) => {
  // QR code stable identifier lookup (also works for manual fallback search)
  const lot = await getLotByNumber(String(req.params.lotNumber ?? ''), req.cold!.organizationIds[0]!);
  if (!lot) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lot not found' } });
  res.json(lot);
}));
coldInventoryRouter.get('/lots/:lotId', asyncHandler(async (req, res) => {
  res.json(await getLotProfile(String(req.params.lotId ?? ''), req.cold!.organizationIds[0]!));
}));

/* Operations (inventory role required) */
coldInventoryRouter.post('/inward', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    commodityId: z.string().min(1), varietyId: z.string().optional().nullable(), unitId: z.string().min(1),
    quantity: z.number().positive(), weightKg: z.number().nonnegative().optional(), packageCount: z.number().int().nonnegative().optional(),
    packagingId: z.string().optional().nullable(), ownerId: z.string().min(1), locationId: z.string().min(1),
    palletId: z.string().optional().nullable(), isOperatorOwned: z.boolean().optional(), lotNumber: z.string().optional().nullable(),
    clientOpId: z.string().optional().nullable(), notes: z.string().optional()
  }), req.body);
  res.status(201).json(await recordInward({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/outward', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    lotId: z.string().min(1), quantity: z.number().positive(), unitId: z.string().min(1),
    weightKg: z.number().nonnegative().optional(), packageCount: z.number().int().nonnegative().optional(),
    reason: z.string().optional(), reasonCode: z.string().optional(), authorizedById: z.string().optional().nullable(),
    clientOpId: z.string().optional().nullable(), gatepassId: z.string().optional().nullable()
  }), req.body);
  res.json(await recordOutward({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/relocate', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ lotId: z.string().min(1), toLocationId: z.string().min(1), palletId: z.string().optional().nullable(), reason: z.string().optional() }), req.body);
  res.json(await relocateLot({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/adjust', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ lotId: z.string().min(1), deltaQuantity: z.number(), reason: z.string().min(1), reasonCode: z.string().min(1), unitId: z.string().min(1), authorizedById: z.string().min(1), clientOpId: z.string().optional().nullable() }), req.body);
  res.json(await adjustLot({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/split', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    sourceLotId: z.string().min(1),
    allocations: z.array(z.object({ quantity: z.number().positive(), unitId: z.string().min(1), locationId: z.string().min(1), palletId: z.string().optional().nullable(), notes: z.string().optional() })).min(1),
    reason: z.string().min(1), clientOpId: z.string().optional().nullable()
  }), req.body);
  res.status(201).json(await splitLot({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/merge', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    sourceLotIds: z.array(z.string().min(1)).min(2), targetLotId: z.string().optional().nullable(),
    targetLocationId: z.string().min(1), unitId: z.string().min(1), reason: z.string().min(1), clientOpId: z.string().optional().nullable()
  }), req.body);
  res.status(201).json(await mergeLots({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/lots/:lotId/ownership', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ toOwnerId: z.string().min(1), reason: z.string().min(1), expectedOwnerId: z.string().optional().nullable() }), req.body);
  res.json(await transferOwnership({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, lotId: String(req.params.lotId ?? ''), ...body }, req.auth!.subject, req.cold!.role));
}));

/* Gatepasses */
coldInventoryRouter.get('/gatepasses', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().optional(), status: z.string().optional(), type: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listGatepasses({ organizationId: req.cold!.organizationIds[0]!, facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined, status: query.status, type: query.type, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));
coldInventoryRouter.post('/gatepasses', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator', 'GateOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    type: z.enum(['Inward', 'Outward', 'TransferDispatch', 'TransferReceive', 'Return']), partyId: z.string().optional().nullable(),
    vehicleId: z.string().optional().nullable(), driverId: z.string().optional().nullable(), transportReference: z.string().optional(),
    items: z.array(z.object({ lotId: z.string().optional().nullable(), commodityId: z.string().min(1), quantity: z.number().positive(), unitId: z.string().min(1), packageCount: z.number().int().optional() })).min(1),
    clientOpId: z.string().optional().nullable()
  }), req.body);
  res.status(201).json(await createGatepass({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/gatepasses/:gatepassId/open', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator', 'GateOperator'), asyncHandler(async (req, res) => {
  res.json(await openGatepass({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, gatepassId: String(req.params.gatepassId ?? '') }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/gatepasses/:gatepassId/complete', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator', 'GateOperator'), asyncHandler(async (req, res) => {
  res.json(await completeGatepass({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, gatepassId: String(req.params.gatepassId ?? '') }, req.auth!.subject, req.cold!.role));
}));

/* Inter-facility transfers */
coldInventoryRouter.get('/transfers', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().optional(), status: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listTransfers({ organizationId: req.cold!.organizationIds[0]!, facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined, status: query.status, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));
coldInventoryRouter.post('/transfers', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    toFacilityId: z.string().min(1),
    items: z.array(z.object({ lotId: z.string().min(1), commodityId: z.string().min(1), quantity: z.number().positive(), unitId: z.string().min(1), packageCount: z.number().int().optional() })).min(1),
    vehicleId: z.string().optional().nullable(), driverId: z.string().optional().nullable(), note: z.string().optional()
  }), req.body);
  res.status(201).json(await createTransfer({ organizationId: req.cold!.organizationIds[0]!, fromFacilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/transfers/:transferId/dispatch', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  res.json(await dispatchTransfer({ organizationId: req.cold!.organizationIds[0]!, transferId: String(req.params.transferId ?? '') }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/transfers/:transferId/receive', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ receivedItems: z.array(z.object({ lotId: z.string().min(1), receivedQty: z.number().nonnegative(), damageQty: z.number().nonnegative().optional(), note: z.string().optional() })).optional() }), req.body);
  res.json(await receiveTransfer({ organizationId: req.cold!.organizationIds[0]!, transferId: String(req.params.transferId ?? ''), ...body }, req.auth!.subject, req.cold!.role));
}));

/* Trips */
coldInventoryRouter.get('/trips', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().optional(), status: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listTrips({ organizationId: req.cold!.organizationIds[0]!, facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined, status: query.status, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));
coldInventoryRouter.post('/trips', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ transferId: z.string().optional().nullable(), vehicleId: z.string().min(1), driverId: z.string().optional().nullable() }), req.body);
  res.status(201).json(await createTrip({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldInventoryRouter.post('/trips/:tripId/status', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['Departed', 'Arrived', 'Completed', 'Cancelled']), note: z.string().optional() }), req.body);
  res.json(await updateTripStatus({ organizationId: req.cold!.organizationIds[0]!, tripId: String(req.params.tripId ?? ''), ...body }, req.auth!.subject, req.cold!.role));
}));
