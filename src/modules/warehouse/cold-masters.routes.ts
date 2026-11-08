import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { coldAuth, coldFacilityRequired, coldRoleGuard } from './cold.middleware.js';
import { createChargeType, createCommodity, createPackaging, createStorageLocation, createUnit, createVariety, listChargeTypes, listCommodities, listPackagings, listStorageLocations, listUnits, listVarieties, updateCommodity } from './master.service.js';
import { createFacility, createParty, createDriver, createEmployee, createVehicle, listFacilities, listDrivers, listEmployees, listParties, listVehicles } from './org.service.js';
import { resolveOrganizationId } from './scoping.js';

export const coldRouter = Router();
coldRouter.use(coldAuth);

/* Masters (read-only role can read; writes require FacilityManager+) */
coldRouter.get('/facilities', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listFacilities(query.organizationId) });
}));

coldRouter.post('/facilities', coldRoleGuard('OrgAdmin'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    organizationId: z.string().min(1), name: z.string().min(1), code: z.string().min(1),
    address: z.string().optional(), timezone: z.string().optional(),
    freezingCapacityKg: z.number().nonnegative().optional(), coldStorageCapacityKg: z.number().nonnegative().optional(), ambientCapacityKg: z.number().nonnegative().optional()
  }), req.body);
  res.status(201).json(await createFacility(body, req.auth!.subject));
}));

/* Parties */
coldRouter.get('/parties', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1), partyType: z.string().optional(), search: z.string().optional() }), req.query as Record<string, unknown>);
  res.json({ items: await listParties(query) });
}));
coldRouter.post('/parties', coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    organizationId: z.string().min(1), partyType: z.enum(['Customer', 'Farmer', 'Trader', 'Supplier', 'Other']),
    name: z.string().min(1), legalName: z.string().optional(), contactPerson: z.string().optional(),
    phone: z.string().optional(), email: z.string().optional(), gstin: z.string().optional(), creditLimit: z.number().nonnegative().optional()
  }), req.body);
  res.status(201).json(await createParty(body, req.auth!.subject));
}));

/* Employees / drivers / vehicles */
coldRouter.get('/employees', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listEmployees(query.facilityId) });
}));
coldRouter.post('/employees', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ organizationId: z.string().min(1), facilityId: z.string().min(1), name: z.string().min(1), designation: z.string().optional(), phone: z.string().optional() }), req.body);
  res.status(201).json(await createEmployee(body, req.auth!.subject));
}));
coldRouter.get('/vehicles', asyncHandler(async (req, res) => {
  const query = parse(z.object({ facilityId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listVehicles(query.facilityId) });
}));
coldRouter.post('/vehicles', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    organizationId: z.string().min(1), facilityId: z.string().min(1), registrationNumber: z.string().min(1),
    makeModel: z.string().optional(), capacityTonne: z.number().nonnegative().optional(),
    trackerStatus: z.string().optional(), trackerProvider: z.string().optional(), trackerDeviceId: z.string().optional()
  }), req.body);
  res.status(201).json(await createVehicle(body, req.auth!.subject));
}));
coldRouter.get('/drivers', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listDrivers(query.organizationId) });
}));
coldRouter.post('/drivers', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ organizationId: z.string().min(1), name: z.string().min(1), phone: z.string().optional(), licenseNumber: z.string().optional() }), req.body);
  res.status(201).json(await createDriver(body, req.auth!.subject));
}));

/* Commodities / units / locations / pallets / charge types */
coldRouter.get('/commodities', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listCommodities(query.organizationId) });
}));
coldRouter.post('/commodities', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ organizationId: z.string().min(1), name: z.string().min(1), commodityCode: z.string().optional(), defaultUnitId: z.string().optional(), isPerishable: z.boolean().optional(), idealStorageTempC: z.number().optional().nullable(), moistureMinPct: z.number().optional().nullable(), moistureMaxPct: z.number().optional().nullable(), exchangeSymbol: z.string().optional().nullable() }), req.body);
  res.status(201).json(await createCommodity(body, req.auth!.subject));
}));
coldRouter.patch('/commodities/:commodityId', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1).optional(), commodityCode: z.string().optional(), defaultUnitId: z.string().optional().nullable(),
    isPerishable: z.boolean().optional(), idealStorageTempC: z.number().optional().nullable(),
    moistureMinPct: z.number().optional().nullable(), moistureMaxPct: z.number().optional().nullable(),
    exchangeSymbol: z.string().optional().nullable()
  }), req.body);
  const commodity = await updateCommodity({ commodityId: String(req.params.commodityId ?? ''), ...body }, req.auth!.subject);
  res.json(commodity);
}));
coldRouter.get('/varieties', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1), commodityId: z.string().optional() }), req.query as Record<string, unknown>);
  res.json({ items: await listVarieties(query.organizationId, query.commodityId) });
}));
coldRouter.post('/varieties', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ organizationId: z.string().min(1), commodityId: z.string().min(1), name: z.string().min(1), grade: z.string().optional() }), req.body);
  res.status(201).json(await createVariety(body, req.auth!.subject));
}));
coldRouter.get('/units', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listUnits(query.organizationId) });
}));
coldRouter.post('/units', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ organizationId: z.string().min(1), code: z.string().min(1), name: z.string().min(1), category: z.enum(['Count', 'Weight', 'Volume']), baseWeightKg: z.number().optional().nullable(), conversions: z.array(z.object({ toUnitId: z.string().min(1), factor: z.number().positive() })).optional() }), req.body);
  res.status(201).json(await createUnit(body, req.auth!.subject));
}));
coldRouter.get('/packagings', asyncHandler(async (req, res) => {
  const query = parse(z.object({ organizationId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listPackagings(query.organizationId) });
}));
coldRouter.post('/packagings', coldRoleGuard('OrgAdmin', 'FacilityManager'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ organizationId: z.string().min(1), name: z.string().min(1), unitId: z.string().min(1), itemsPerHandlingUnit: z.number().optional().nullable(), weightPerItemKg: z.number().optional().nullable() }), req.body);
  res.status(201).json(await createPackaging(body, req.auth!.subject));
}));

/* Storage locations & charge types (facility-scoped) */
coldRouter.get('/locations', coldFacilityRequired, asyncHandler(async (req, res) => {
  res.json({ items: await listStorageLocations(req.cold!.facilityId!) });
}));
coldRouter.post('/locations', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'InventoryOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    type: z.enum(['Shed', 'Chamber', 'Rack', 'Slot', 'OpenArea']), name: z.string().min(1), code: z.string().min(1),
    parentLocationId: z.string().optional().nullable(), capacityBags: z.number().nonnegative().optional(), capacityKg: z.number().nonnegative().optional(),
    capacityModel: z.enum(['Bags', 'Weight', 'BagsAndWeight']).optional(), handlerType: z.string().optional(), minTempC: z.number().optional().nullable(), maxTempC: z.number().optional().nullable()
  }), req.body);
  res.status(201).json(await createStorageLocation({ organizationId: await resolveOrganizationId(req.cold!), facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject));
}));
coldRouter.get('/charge-types', coldFacilityRequired, asyncHandler(async (req, res) => {
  res.json({ items: await listChargeTypes(req.cold!.facilityId!) });
}));
coldRouter.post('/charge-types', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1), billType: z.enum(['Storage', 'HandlingInward', 'HandlingOutward', 'Loading', 'Unloading', 'Transport', 'Packaging', 'Service', 'Other']),
    base: z.enum(['quantity', 'weight', 'bags', 'pallets', 'duration', 'contract']), rate: z.number().optional(), unitId: z.string().optional().nullable(),
    taxRatePct: z.number().optional(), freeDays: z.number().int().optional(), minimumPeriodDays: z.number().int().optional(),
    partialDayRule: z.enum(['chargeFullDay', 'prorate', 'roundUpHalfDay']).optional(), roundingRule: z.enum(['none', 'round', 'ceil', 'floor']).optional(), ruleConfig: z.unknown().optional()
  }), req.body);
  res.status(201).json(await createChargeType({ organizationId: await resolveOrganizationId(req.cold!), facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject));
}));
