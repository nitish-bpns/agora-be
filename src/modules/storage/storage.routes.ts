import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { asyncHandler, pagination, parse } from '../../common/http.js';
import { authenticate, authorize, requireRealm } from '../auth/auth.middleware.js';
import { CustodyLot, CustodyTransfer, Vault } from './storage.models.js';
import { depositLot, registerVault, transferLot } from './storage.service.js';

export const storageRouter = Router();
storageRouter.use(authenticate, requireRealm('Storage'), authorize('Admin', 'Operations', 'Read-only'));
storageRouter.get('/dashboard', asyncHandler(async (_req, res) => {
  const [vaults, lots, transfers, inventory] = await Promise.all([Vault.countDocuments(), CustodyLot.countDocuments({ status: 'Held' }), CustodyTransfer.countDocuments(), CustodyLot.aggregate([{ $match: { status: 'Held' } }, { $group: { _id: '$securitySymbol', weight: { $sum: '$weight' }, lots: { $sum: 1 } } }])]);
  res.json({ vaults, lots, transfers, inventory });
}));
storageRouter.get('/vaults', asyncHandler(async (_req, res) => res.json({ items: await Vault.find().sort({ name: 1 }).lean() })));
storageRouter.post('/vaults', authorize('Admin', 'Operations'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ depositoryId: z.string().min(1), name: z.string().min(1) }), req.body);
  res.status(201).json(await registerVault(body.depositoryId, body.name, req.auth!.subject));
}));
storageRouter.get('/lots', asyncHandler(async (req, res) => {
  const { page, limit, skip } = pagination(req.query); const filter: Record<string, unknown> = {};
  for (const key of ['depositoryId', 'ownerId', 'securityId', 'status'] as const) if (req.query[key]) filter[key] = req.query[key];
  const [items, total] = await Promise.all([CustodyLot.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), CustodyLot.countDocuments(filter)]);
  res.json({ items, total, page, limit });
}));
storageRouter.get('/transfers', asyncHandler(async (req, res) => {
  const { page, limit, skip } = pagination(req.query); const filter: Record<string, unknown> = {};
  if (req.query.lotId) filter.lotId = req.query.lotId;
  const [items, total] = await Promise.all([CustodyTransfer.find(filter).sort({ at: -1 }).skip(skip).limit(limit).lean(), CustodyTransfer.countDocuments(filter)]);
  res.json({ items, total, page, limit });
}));
storageRouter.post('/lots', authorize('Admin', 'Operations'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ lotId: z.string().optional(), depositoryId: z.string().min(1), securityId: z.string().min(1), securitySymbol: z.string().min(1), ownerId: z.string().min(1), weight: z.number().positive(), properties: z.unknown().optional() }), req.body);
  res.status(201).json(await depositLot(body, req.auth!.subject));
}));
storageRouter.post('/lots/:lotId/transfer', authorize('Admin', 'Operations'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ toOwner: z.string().min(1), reason: z.string().min(1) }), req.body);
  res.json(await transferLot(String(req.params.lotId ?? ''), body.toOwner, body.reason, req.auth!.subject));
}));
storageRouter.get('/lots/:lotId/history', asyncHandler(async (req, res) => {
  const lot = await CustodyLot.findOne({ lotId: req.params.lotId }).lean(); if (!lot) throw new ApiError(404, 'Lot not found');
  res.json({ lot, transfers: await CustodyTransfer.find({ lotId: lot.lotId }).sort({ at: -1 }).lean() });
}));
