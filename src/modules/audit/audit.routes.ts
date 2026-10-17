import { Router } from 'express';
import { asyncHandler, pagination } from '../../common/http.js';
import { authenticate } from '../auth/auth.middleware.js';
import { AuditEvent } from './audit.model.js';

export const auditRouter = Router();
auditRouter.use(authenticate);
auditRouter.get('/', asyncHandler(async (req, res) => {
  const { page, limit, skip } = pagination(req.query);
  const filter: Record<string, unknown> = { realm: req.auth!.realm };
  for (const key of ['collection', 'recordId', 'action', 'actorId'] as const) if (req.query[key]) filter[key] = req.query[key];
  const [items, total] = await Promise.all([AuditEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), AuditEvent.countDocuments(filter)]);
  res.json({ items, page, limit, total });
}));
