import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Lead } from './public.models.js';

/**
 * Public website contact form — captures a sales lead. Open to anyone on the
 * internet; no authentication required. Rate-limited at the router level.
 */
export async function createLead(input: {
  name: string; email: string; phone?: string; company?: string;
  interest?: string; message: string; source?: string;
}, meta: { ip?: string } = {}): Promise<object> {
  if (!input.name.trim()) throw new ApiError(400, 'Name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new ApiError(400, 'A valid email is required');
  if (!input.message.trim()) throw new ApiError(400, 'Message is required');
  const leadId = await nextId('lead');
  const lead = await Lead.create({
    leadId, name: input.name.trim(), email: input.email.trim().toLowerCase(),
    phone: input.phone?.trim() ?? '', company: input.company?.trim() ?? '',
    interest: input.interest?.trim() ?? 'General enquiry', message: input.message.trim(),
    source: input.source ?? 'website', ipAddress: meta.ip ?? ''
  });
  await recordAudit({ realm: 'Cold', collection: 'leads', recordId: leadId, action: 'Enquiry', metadata: { name: lead.name, email: lead.email, interest: lead.interest } });
  return lead.toObject();
}

/** List leads (used by the ops console / central admin triage). */
export async function listLeads(input: { status?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Lead.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

export async function updateLeadStatus(leadId: string, status: string, actorId: string): Promise<object> {
  const lead = await Lead.findOne({ leadId });
  if (!lead) throw new ApiError(404, `Lead ${leadId} was not found`);
  const before = lead.toObject();
  lead.status = status as typeof lead.status;
  await lead.save();
  await recordAudit({ realm: 'Cold', collection: 'leads', recordId: leadId, action: 'Status', actorId, before, after: lead.toObject() });
  return lead.toObject();
}