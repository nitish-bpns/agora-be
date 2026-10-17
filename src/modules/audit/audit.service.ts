import type { ClientSession } from 'mongoose';
import { nextId } from '../../common/ids.js';
import { AuditEvent } from './audit.model.js';

interface AuditInput {
  realm: 'Desk' | 'Broker' | 'Exchange' | 'Storage';
  collection: string;
  recordId: string;
  action: string;
  actorId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata?: unknown;
}

function stable(value: unknown): unknown {
  if (typeof value === 'number') return Number(value.toFixed(10));
  if (value instanceof Date) return value.toISOString();
  return value;
}

export async function recordAudit(input: AuditInput, session?: ClientSession): Promise<void> {
  const before = input.before ?? {};
  const after = input.after ?? {};
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [...fields].filter((field) => !['_id', '__v', 'updatedAt'].includes(field)).filter((field) => JSON.stringify(stable(before[field])) !== JSON.stringify(stable(after[field])));
  if (changes.length === 0) changes.push('*');
  const docs = await Promise.all(changes.map(async (field) => ({
    auditId: await nextId('audit'), realm: input.realm, collection: input.collection, recordId: input.recordId,
    action: input.action, field, oldValue: field === '*' ? undefined : stable(before[field]),
    newValue: field === '*' ? input.metadata : stable(after[field]), actorId: input.actorId ?? 'system', metadata: input.metadata
  })));
  await AuditEvent.insertMany(docs, session ? { session } : {});
}
