import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { coldAuth } from './cold.middleware.js';
import { networkOverview, centralListFacilities, centralListTransfers, centralListTrips } from './central.service.js';
import { createOrganization, createFacility, createFacilityUserAccount, createCustomerAccount, createEmployeeAccount, createFinancerAccount, listFacilityUsers } from './org.service.js';

export const coldCentralRouter = Router();
coldCentralRouter.use(coldAuth);

/** Current cold identity: central admin vs facility user, resolved role and facility. */
coldCentralRouter.get('/me', asyncHandler(async (req, res) => {
  res.json({
    isCentralAdmin: Boolean(req.cold?.isCentralAdmin),
    facilityId: req.cold?.facilityId ?? null,
    role: req.cold?.role ?? null,
    organizationIds: req.cold?.organizationIds ?? [],
    organizationId: req.cold?.organizationId ?? null
  });
}));

/** Guard: only central administrators (Cold realm, Admin role) may use the network console. */
function centralOnly(req: { cold?: { isCentralAdmin?: boolean } }): boolean {
  return Boolean(req.cold?.isCentralAdmin);
}
function requireCentral(req: { cold?: { isCentralAdmin?: boolean } }, res: { status(code: number): { json(body: unknown): void } }): boolean {
  if (!centralOnly(req)) {
    res.status(403).json({ error: { code: 'COLD_FORBIDDEN', message: 'This requires central-administrator access' } });
    return false;
  }
  return true;
}

/** Central administrator network console: all facilities, transports, trips and storage health. */
coldCentralRouter.get('/network', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  res.json(await networkOverview());
}));

coldCentralRouter.get('/network/facilities', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  res.json({ items: await centralListFacilities() });
}));

coldCentralRouter.get('/network/transfers', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const query = parse(z.object({ status: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await centralListTransfers({ status: query.status, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));

coldCentralRouter.get('/network/trips', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const query = parse(z.object({ status: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await centralListTrips({ status: query.status, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));

/** Central admin: create an organization (then facilities within it). */
coldCentralRouter.post('/organizations', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const body = parse(z.object({ name: z.string().min(1), tin: z.string().optional(), gstin: z.string().optional(), address: z.string().optional(), timezone: z.string().optional() }), req.body);
  res.status(201).json(await createOrganization(body, req.auth!.subject));
}));

/** Central admin: create a facility (any org in the network). */
coldCentralRouter.post('/network/facilities', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const body = parse(z.object({
    organizationId: z.string().min(1), name: z.string().min(1), code: z.string().min(1),
    address: z.string().optional(), timezone: z.string().optional(),
    freezingCapacityKg: z.number().nonnegative().optional(), coldStorageCapacityKg: z.number().nonnegative().optional(), ambientCapacityKg: z.number().nonnegative().optional()
  }), req.body);
  res.status(201).json(await createFacility(body, req.auth!.subject));
}));

/** Central admin: list facility-user accounts for a facility. */
coldCentralRouter.get('/network/facility-users', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const query = parse(z.object({ facilityId: z.string().min(1) }), req.query as Record<string, unknown>);
  res.json({ items: await listFacilityUsers(query.facilityId) });
}));

/** Central admin: create a facility-owner login (User + FacilityUser assignment). */
coldCentralRouter.post('/network/facility-users', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const body = parse(z.object({
    organizationId: z.string().min(1), facilityId: z.string().min(1),
    username: z.string().min(3), displayName: z.string().min(1), password: z.string().min(8),
    role: z.enum(['OrgAdmin', 'FacilityManager', 'InventoryOperator', 'AccountsOperator', 'GateOperator', 'Auditor'])
  }), req.body);
  res.status(201).json(await createFacilityUserAccount(body, req.auth!.subject));
}));

/** Central admin: create a customer (depositor) login linked to a Party. */
coldCentralRouter.post('/network/customer-accounts', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const body = parse(z.object({
    organizationId: z.string().min(1), partyId: z.string().min(1),
    username: z.string().min(3), displayName: z.string().min(1), password: z.string().min(8)
  }), req.body);
  res.status(201).json(await createCustomerAccount(body, req.auth!.subject));
}));

/** Central admin: create an employee login scoped to a facility. */
coldCentralRouter.post('/network/employee-accounts', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const body = parse(z.object({
    organizationId: z.string().min(1), facilityId: z.string().min(1),
    username: z.string().min(3), displayName: z.string().min(1), password: z.string().min(8)
  }), req.body);
  res.status(201).json(await createEmployeeAccount(body, req.auth!.subject));
}));

/** Central admin: create a financer login linked to a Financer record. */
coldCentralRouter.post('/network/financer-accounts', asyncHandler(async (req, res) => {
  if (!requireCentral(req, res)) return;
  const body = parse(z.object({
    financerId: z.string().min(1),
    username: z.string().min(3), displayName: z.string().min(1), password: z.string().min(8)
  }), req.body);
  res.status(201).json(await createFinancerAccount(body, req.auth!.subject));
}));
