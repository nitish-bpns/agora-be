import type { ClientSession } from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { CustodyLot, CustodyTransfer, Vault } from './storage.models.js';

export async function registerVault(depositoryId: string, name: string, actorId: string): Promise<object> {
  const vault = await Vault.create({ depositoryId, name });
  await recordAudit({ realm: 'Storage', collection: 'vaults', recordId: depositoryId, action: 'Create', actorId, after: vault.toObject() });
  return vault.toObject();
}

export async function depositLot(input: { lotId?: string | undefined; depositoryId: string; securityId: string; securitySymbol: string; ownerId: string; weight: number; properties?: unknown }, actorId: string): Promise<object> {
  const vault = await Vault.findOne({ depositoryId: input.depositoryId, status: 'Active' });
  if (!vault) throw new ApiError(409, 'An active vault is required for this depository');
  const lotId = input.lotId || await nextId('lot');
  const lot = await CustodyLot.create({ ...input, lotId });
  await recordAudit({ realm: 'Storage', collection: 'lots', recordId: lotId, action: 'Deposit', actorId, after: lot.toObject() });
  return lot.toObject();
}

export async function transferLot(lotId: string, toOwner: string, reason: string, actorId: string, session?: ClientSession, expectedOwner?: string): Promise<object> {
  const lot = await CustodyLot.findOne({ lotId }).session(session ?? null);
  if (!lot) throw new ApiError(404, `Custody lot ${lotId} was not found`);
  if (lot.status === 'Withdrawn') throw new ApiError(409, `Custody lot ${lotId} has been withdrawn`);
  if (expectedOwner && lot.ownerId !== expectedOwner) throw new ApiError(409, `Custody lot ${lotId} is not owned by the delivering broker`, 'OWNER_MISMATCH');
  if (lot.ownerId === toOwner) throw new ApiError(409, `Custody lot ${lotId} is already owned by ${toOwner}`);
  const fromOwner = lot.ownerId;
  lot.ownerId = toOwner;
  await lot.save(session ? { session } : {});
  const transferId = await nextId('transfer');
  await CustodyTransfer.create([{ transferId, lotId, fromOwner, toOwner, reason, actorId }], { session });
  await recordAudit({ realm: 'Storage', collection: 'lots', recordId: lotId, action: 'Transfer', actorId, before: { ownerId: fromOwner }, after: { ownerId: toOwner }, metadata: { reason, transferId } }, session);
  return lot.toObject();
}

export async function transferLots(lotIds: string[], fromOwner: string, toOwner: string, reason: string, actorId: string, session: ClientSession): Promise<void> {
  for (const lotId of lotIds) await transferLot(lotId, toOwner, reason, actorId, session, fromOwner);
}
