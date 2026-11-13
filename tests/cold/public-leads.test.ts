import { beforeEach, describe, expect, it } from 'vitest';
import { Lead } from '../../src/modules/public/public.models.js';
import { createLead, listLeads, updateLeadStatus } from '../../src/modules/public/public.service.js';
import { clearDatabase } from './test-db.js';

beforeEach(async () => {
  await clearDatabase();
});

describe('public website leads', () => {
  it('creates a lead from the public contact form', async () => {
    const lead = await createLead({ name: 'Prospect', email: 'p@example.com', message: 'We run 3 facilities.' }, { ip: '1.2.3.4' }) as { leadId: string; email: string; status: string; ipAddress: string };
    expect(lead.leadId).toMatch(/^LEAD-/);
    expect(lead.email).toBe('p@example.com');
    expect(lead.status).toBe('New');
    expect(lead.ipAddress).toBe('1.2.3.4');
  });

  it('rejects an invalid email', async () => {
    await expect(createLead({ name: 'X', email: 'not-an-email', message: 'hi' })).rejects.toThrow('valid email');
  });

  it('rejects a blank message', async () => {
    await expect(createLead({ name: 'X', email: 'a@b.com', message: '   ' })).rejects.toThrow('Message is required');
  });

  it('lists leads newest first and filters by status', async () => {
    await createLead({ name: 'A', email: 'a@b.com', message: 'm1' });
    await createLead({ name: 'B', email: 'b@b.com', message: 'm2' });
    const all = await listLeads({}) as { items: Array<{ name: string }>; total: number };
    expect(all.total).toBe(2);
    expect(all.items[0]?.name).toBe('B'); // newest first
    const lead = await Lead.findOne({ name: 'A' }).lean();
    await updateLeadStatus(String(lead?.leadId), 'Contacted', 'USR-ADMIN');
    const contacted = await listLeads({ status: 'Contacted' }) as { items: Array<{ name: string }>; total: number };
    expect(contacted.total).toBe(1);
    expect(contacted.items[0]?.name).toBe('A');
  });
});