import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { ApiError } from '../../common/errors.js';
import { coldAuth } from './cold.middleware.js';
import { authenticate } from '../auth/auth.middleware.js';
import {
  createFinancer, listFinancers, updateFinancer,
  createPledgeApplication, listPledgeApplications, reactToApplication,
  listPledges, getPledge, accrueInterest, repayPledge, releasePledgeStock,
  refreshPledgeValuation, refreshAllPledges, getLivePrice
} from './pledge.service.js';

/**
 * Pledge (stock-backed lending) routes.
 * - /ops/pledge/*       — central admin + facility users (cold realm)
 * - /customer/pledge/*  — customer portal (apply for loans, view own)
 * - /financer/pledge/*  — financer portal (react to applications, view book)
 */
export const pledgeRouter = Router();
pledgeRouter.use(coldAuth);

/* ------------------------- Central admin ------------------------- */

/** Guard: central admin only for financer list management. */
function requireCentral(req: { cold?: { isCentralAdmin?: boolean } }): boolean {
  return Boolean(req.cold?.isCentralAdmin);
}
function centralOnly(req: { cold?: { isCentralAdmin?: boolean } }, res: { status(code: number): { json(body: unknown): void } }): boolean {
  if (!requireCentral(req)) {
    res.status(403).json({ error: { code: 'COLD_FORBIDDEN', message: 'This requires central-administrator access' } });
    return false;
  }
  return true;
}

// Financers — list (any cold user can see), create/update (central only)
pledgeRouter.get('/pledge/financers', asyncHandler(async (req, res) => {
  const query = parse(z.object({ status: z.string().optional() }), req.query as Record<string, unknown>);
  res.json({ items: await listFinancers({ organizationId: req.cold!.organizationId ?? undefined, status: query.status }) });
}));
pledgeRouter.post('/pledge/financers', asyncHandler(async (req, res) => {
  if (!centralOnly(req, res)) return;
  const body = parse(z.object({
    organizationId: z.string().optional().nullable(), name: z.string().min(1),
    financerType: z.enum(['Bank', 'NBFC', 'Cooperative', 'PrivateLender', 'StorageOwner', 'Other']),
    contactPerson: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
    address: z.string().optional(), gstin: z.string().optional(), pan: z.string().optional(),
    maxLoanAmount: z.number().nonnegative().optional(), minLoanAmount: z.number().nonnegative().optional(),
    interestRatePct: z.number().min(0).optional(), maxLtvPct: z.number().min(0).max(100).optional(), tenureMonths: z.number().int().positive().optional()
  }), req.body);
  res.status(201).json(await createFinancer(body, req.auth!.subject));
}));
pledgeRouter.patch('/pledge/financers/:financerId', asyncHandler(async (req, res) => {
  if (!centralOnly(req, res)) return;
  const body = parse(z.object({
    name: z.string().min(1).optional(), financerType: z.enum(['Bank', 'NBFC', 'Cooperative', 'PrivateLender', 'StorageOwner', 'Other']).optional(),
    contactPerson: z.string().optional(), phone: z.string().optional(), email: z.string().optional(),
    address: z.string().optional(), gstin: z.string().optional(), pan: z.string().optional(),
    maxLoanAmount: z.number().nonnegative().optional(), minLoanAmount: z.number().nonnegative().optional(),
    interestRatePct: z.number().min(0).optional(), maxLtvPct: z.number().min(0).max(100).optional(), tenureMonths: z.number().int().positive().optional(),
    status: z.enum(['Active', 'Inactive', 'Blacklisted']).optional()
  }), req.body);
  res.json(await updateFinancer({ financerId: String(req.params.financerId ?? ''), ...body }, req.auth!.subject));
}));

// Applications — central sees all
pledgeRouter.get('/pledge/applications', asyncHandler(async (req, res) => {
  const query = parse(z.object({ status: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listPledgeApplications({
    organizationId: req.cold!.organizationId ?? undefined,
    status: query.status, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined
  }));
}));

// Pledges — central sees all + operations
pledgeRouter.get('/pledge/pledges', asyncHandler(async (req, res) => {
  const query = parse(z.object({ status: z.string().optional(), financerId: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listPledges({
    organizationId: req.cold!.organizationId ?? undefined, status: query.status, financerId: query.financerId,
    page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined
  }));
}));
pledgeRouter.get('/pledge/pledges/:pledgeId', asyncHandler(async (req, res) => {
  res.json(await getPledge(String(req.params.pledgeId ?? '')));
}));
pledgeRouter.post('/pledge/pledges/:pledgeId/accrue', asyncHandler(async (req, res) => {
  res.json(await accrueInterest({ pledgeId: String(req.params.pledgeId ?? '') }, req.auth!.subject));
}));
pledgeRouter.post('/pledge/pledges/:pledgeId/repay', asyncHandler(async (req, res) => {
  const body = parse(z.object({ principalAmount: z.number().min(0).optional(), interestAmount: z.number().min(0).optional(), narration: z.string().optional() }), req.body);
  res.json(await repayPledge({ pledgeId: String(req.params.pledgeId ?? ''), ...body }, req.auth!.subject));
}));
pledgeRouter.post('/pledge/pledges/:pledgeId/release', asyncHandler(async (req, res) => {
  const body = parse(z.object({ quantity: z.number().positive() }), req.body);
  res.json(await releasePledgeStock({ pledgeId: String(req.params.pledgeId ?? ''), quantity: body.quantity }, req.auth!.subject));
}));

// Exchange-linked margin monitoring
pledgeRouter.get('/pledge/live-price', asyncHandler(async (req, res) => {
  const query = parse(z.object({ commodityId: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await getLivePrice({ commodityId: query.commodityId ?? null }));
}));
pledgeRouter.post('/pledge/pledges/:pledgeId/valuate', asyncHandler(async (req, res) => {
  const result = await refreshPledgeValuation(String(req.params.pledgeId ?? ''), req.auth!.subject);
  res.json({ pledge: result?.pledge ? (result.pledge as unknown as { toObject(): unknown }).toObject() : null, live: result?.live ?? null, transaction: result?.transaction?.toObject() ?? null });
}));
pledgeRouter.post('/pledge/valuation/refresh', asyncHandler(async (req, res) => {
  const body = parse(z.object({ financerId: z.string().optional().nullable() }), req.body);
  res.json(await refreshAllPledges({ organizationId: req.cold!.organizationId ?? undefined, financerId: body.financerId ?? null }, req.auth!.subject));
}));

/* ------------------------- Customer portal ------------------------ */
export const customerPledgeRouter = Router();
customerPledgeRouter.use(authenticate);

function requireParty(req: { auth?: { partyId?: string } }): string {
  if (!req.auth?.partyId) throw new ApiError(403, 'This customer identity has no linked party', 'NO_PARTY_LINK');
  return req.auth.partyId;
}

customerPledgeRouter.get('/pledge/financers', asyncHandler(async (_req, res) => {
  res.json({ items: await listFinancers({ status: 'Active' }) });
}));
customerPledgeRouter.get('/pledge/applications', asyncHandler(async (req, res) => {
  const partyId = requireParty(req);
  res.json(await listPledgeApplications({ applicantPartyId: partyId }));
}));
customerPledgeRouter.post('/pledge/applications', asyncHandler(async (req, res) => {
  const partyId = requireParty(req);
  const body = parse(z.object({
    organizationId: z.string().min(1), facilityId: z.string().min(1), lotId: z.string().min(1),
    quantity: z.number().positive(), unitId: z.string().min(1),
    stockValue: z.number().positive(), requestedAmount: z.number().positive(),
    financerId: z.string().optional().nullable(), requestedTenureMonths: z.number().int().positive().optional(), purpose: z.string().optional()
  }), req.body);
  res.status(201).json(await createPledgeApplication({ ...body, applicantPartyId: partyId, applicantUserId: req.auth!.subject }, req.auth!.subject));
}));
customerPledgeRouter.get('/pledge/pledges', asyncHandler(async (req, res) => {
  const partyId = requireParty(req);
  res.json(await listPledges({ borrowerPartyId: partyId }));
}));
customerPledgeRouter.get('/pledge/pledges/:pledgeId', asyncHandler(async (req, res) => {
  res.json(await getPledge(String(req.params.pledgeId ?? '')));
}));
// Live margin valuation for the borrower's pledges (exchange-linked price).
customerPledgeRouter.post('/pledge/pledges/:pledgeId/valuate', asyncHandler(async (req, res) => {
  const partyId = requireParty(req);
  const result = await refreshPledgeValuation(String(req.params.pledgeId ?? ''), req.auth!.subject);
  if (result?.pledge && result.pledge.borrowerPartyId !== partyId) throw new ApiError(403, 'This pledge is not yours', 'NOT_YOUR_PLEDGE');
  res.json({ pledge: result?.pledge ? (result.pledge as unknown as { toObject(): unknown }).toObject() : null, live: result?.live ?? null, transaction: result?.transaction?.toObject() ?? null });
}));

/* ------------------------- Financer portal ------------------------ */
export const financerPledgeRouter = Router();
financerPledgeRouter.use(authenticate);

function requireFinancer(req: { auth?: { financerId?: string } }): string {
  if (!req.auth?.financerId) throw new ApiError(403, 'This financer identity has no linked financer record', 'NO_FINANCER_LINK');
  return req.auth.financerId;
}

financerPledgeRouter.get('/pledge/applications', asyncHandler(async (req, res) => {
  const financerId = requireFinancer(req);
  res.json(await listPledgeApplications({ financerId, status: req.query.status ? String(req.query.status) : undefined, page: req.query.page ? Number(req.query.page) : undefined, limit: req.query.limit ? Number(req.query.limit) : undefined }));
}));
financerPledgeRouter.post('/pledge/applications/:applicationId/react', asyncHandler(async (req, res) => {
  const financerId = requireFinancer(req);
  const body = parse(z.object({
    decision: z.enum(['Approved', 'Rejected']),
    approvedAmount: z.number().positive().optional(), interestRatePct: z.number().min(0).optional(),
    tenureMonths: z.number().int().positive().optional(), reason: z.string().optional()
  }), req.body);
  res.json(await reactToApplication({ applicationId: String(req.params.applicationId ?? ''), financerId, ...body }, req.auth!.subject));
}));
financerPledgeRouter.get('/pledge/pledges', asyncHandler(async (req, res) => {
  const financerId = requireFinancer(req);
  res.json(await listPledges({ financerId }));
}));
financerPledgeRouter.get('/pledge/pledges/:pledgeId', asyncHandler(async (req, res) => {
  res.json(await getPledge(String(req.params.pledgeId ?? '')));
}));
// Financer revalues their book (margin call detection).
financerPledgeRouter.post('/pledge/valuation/refresh', asyncHandler(async (req, res) => {
  const financerId = requireFinancer(req);
  res.json(await refreshAllPledges({ financerId }, req.auth!.subject));
}));
financerPledgeRouter.post('/pledge/pledges/:pledgeId/valuate', asyncHandler(async (req, res) => {
  const financerId = requireFinancer(req);
  const result = await refreshPledgeValuation(String(req.params.pledgeId ?? ''), req.auth!.subject);
  if (result?.pledge && result.pledge.financerId !== financerId) throw new ApiError(403, 'This pledge is not on your book', 'NOT_YOUR_PLEDGE');
  res.json({ pledge: result?.pledge ? (result.pledge as unknown as { toObject(): unknown }).toObject() : null, live: result?.live ?? null, transaction: result?.transaction?.toObject() ?? null });
}));
financerPledgeRouter.post('/pledge/pledges/:pledgeId/repay', asyncHandler(async (req, res) => {
  const body = parse(z.object({ principalAmount: z.number().min(0).optional(), interestAmount: z.number().min(0).optional(), narration: z.string().optional() }), req.body);
  res.json(await repayPledge({ pledgeId: String(req.params.pledgeId ?? ''), ...body }, req.auth!.subject));
}));