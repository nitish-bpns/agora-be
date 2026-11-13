import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { createRateLimit } from '../../common/rate-limit.js';
import { coldAuth } from '../warehouse/cold.middleware.js';
import { createLead, listLeads, updateLeadStatus } from './public.service.js';

/**
 * Public marketing-site routes.
 * - POST /api/v1/public/contact — open form submission (rate-limited).
 * - GET/PATCH /api/v1/ops/public-leads — central-admin triage of enquiries.
 */
export const publicRouter = Router();

publicRouter.post('/contact', createRateLimit({ windowMs: 60_000, limit: 10 }), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    name: z.string().min(1), email: z.string().min(1), phone: z.string().optional(),
    company: z.string().optional(), interest: z.string().optional(), message: z.string().min(1)
  }), req.body);
  const lead = await createLead(body, { ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '' });
  res.status(201).json({ ok: true, leadId: String((lead as { leadId?: string }).leadId ?? '') });
}));

export const opsLeadRouter = Router();
opsLeadRouter.use(coldAuth);

opsLeadRouter.get('/', asyncHandler(async (req, res) => {
  const query = parse(z.object({ status: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listLeads({ status: query.status, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));
opsLeadRouter.patch('/:leadId/status', asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['New', 'Contacted', 'Qualified', 'Closed']) }), req.body);
  res.json(await updateLeadStatus(String(req.params.leadId ?? ''), body.status, req.auth!.subject));
}));