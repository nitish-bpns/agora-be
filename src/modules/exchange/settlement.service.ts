import { ApiError } from '../../common/errors.js';
import { inTransaction } from '../../common/transaction.js';
import { recordAudit } from '../audit/audit.service.js';
import { transferLots } from '../storage/storage.service.js';
import { ExchangeLot, Obligation, SettlementInstruction } from './exchange.models.js';

function selectExactLots(lots: Array<{ lotId: string; weight: number }>, required: number): string[] {
  const selected: string[] = []; let total = 0;
  for (const lot of lots) { if (total >= required - 1e-9) break; selected.push(lot.lotId); total += lot.weight; }
  if (Math.abs(total - required) > 1e-8) throw new ApiError(409, `Enlisted lots do not exactly satisfy delivery quantity ${required}`, 'INSUFFICIENT_LOTS');
  return selected;
}

export async function settleExecution(obligationId: string, actorId: string): Promise<object[]> {
  const target = await Obligation.findOne({ obligationId });
  if (!target) throw new ApiError(404, 'Obligation not found');
  if (target.status !== 'Unsettled') throw new ApiError(409, `A ${target.status} obligation cannot be settled`, 'INVALID_TRANSITION');
  return inTransaction(async (session) => {
    const obligations = await Obligation.find({ executionId: target.executionId }).session(session);
    if (obligations.length !== 2 || obligations.some((item) => item.status !== 'Unsettled')) throw new ApiError(409, 'Both bilateral obligations must be open for delivery-versus-payment');
    const seller = obligations.find((item) => item.side === 'Sell')!;
    const buyer = obligations.find((item) => item.side === 'Buy')!;
    const lots = await ExchangeLot.find({ securityId: seller.securityId, ownerBrokerId: seller.brokerId, status: 'Held' }).sort({ createdAt: 1 }).session(session).lean();
    const lotIds = selectExactLots(lots.map((lot) => ({ lotId: lot.lotId, weight: lot.weight })), seller.quantity);
    await ExchangeLot.updateMany({ lotId: { $in: lotIds }, status: 'Held' }, { $set: { status: 'Obligated', obligationId: seller.obligationId } }, { session });
    await transferLots(lotIds, seller.brokerId, buyer.brokerId, `Settlement ${target.executionId}`, actorId, session);
    await ExchangeLot.updateMany({ lotId: { $in: lotIds } }, { $set: { status: 'Delivered', ownerBrokerId: buyer.brokerId } }, { session });
    for (const obligation of obligations) {
      const before = obligation.toObject();
      obligation.status = 'Settled'; obligation.cashLeg = 'Settled'; obligation.securityLeg = 'Attested'; obligation.lotIds = lotIds;
      obligation.deliveredWeight = seller.quantity; obligation.settledAt = new Date(); await obligation.save({ session });
      await SettlementInstruction.updateOne({ obligationId: obligation.obligationId }, { $set: { status: 'Attested', attestedAt: new Date(), attestedBy: actorId } }, { session });
      await recordAudit({ realm: 'Exchange', collection: 'obligations', recordId: obligation.obligationId, action: 'Settle', actorId, before, after: obligation.toObject() }, session);
    }
    return obligations.map((item) => item.toObject());
  });
}

export async function failExecution(obligationId: string, reason: string, actorId: string): Promise<object[]> {
  const target = await Obligation.findOne({ obligationId });
  if (!target) throw new ApiError(404, 'Obligation not found');
  if (target.status !== 'Unsettled') throw new ApiError(409, `A ${target.status} obligation cannot be failed`, 'INVALID_TRANSITION');
  return inTransaction(async (session) => {
    const obligations = await Obligation.find({ executionId: target.executionId }).session(session);
    for (const obligation of obligations) {
      const before = obligation.toObject(); obligation.status = 'Failed'; obligation.cashLeg = 'Failed'; obligation.securityLeg = 'Failed'; obligation.failedReason = reason; await obligation.save({ session });
      await SettlementInstruction.updateOne({ obligationId: obligation.obligationId }, { $set: { status: 'Failed', note: reason } }, { session });
      await recordAudit({ realm: 'Exchange', collection: 'obligations', recordId: obligation.obligationId, action: 'Fail', actorId, before, after: obligation.toObject() }, session);
    }
    await ExchangeLot.updateMany({ obligationId: { $in: obligations.map((item) => item.obligationId) }, status: 'Obligated' }, { $set: { status: 'Held', obligationId: '' } }, { session });
    return obligations.map((item) => item.toObject());
  });
}
