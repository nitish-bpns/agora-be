import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { addBusinessDays, addMonths, isoDate } from '../../common/dates.js';
import { nextId } from '../../common/ids.js';
import { Counter } from '../../common/models.js';
import { inTransaction } from '../../common/transaction.js';
import { recordAudit } from '../audit/audit.service.js';
import { BrokerMember, ExchangeOrder, Execution, Mandi, Obligation, Security, SettlementInstruction } from './exchange.models.js';

export const orderInputSchema = z.object({
  brokerOrderRef: z.string().min(1), symbol: z.string().min(1).transform((v) => v.toUpperCase()), action: z.enum(['Buy', 'Sell']),
  quantity: z.number().positive().max(1_000_000), price: z.number().positive(), tenor: z.enum(['Spot', '1M']).default('Spot'),
  orderType: z.literal('Limit').default('Limit'), timeInForce: z.enum(['GTC', 'DAY']).default('GTC')
});
export type OrderInput = z.infer<typeof orderInputSchema>;

async function nextSequence(session: ClientSession): Promise<number> {
  const counter = await Counter.findOneAndUpdate({ name: 'market-sequence' }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
  return counter.value;
}

function multipleOf(value: number, increment: number): boolean {
  const units = value / increment;
  return Math.abs(units - Math.round(units)) < 1e-8;
}

async function rejectReason(input: OrderInput, mandiId: string): Promise<{ securityId: string; reason: string }> {
  const [mandi, security] = await Promise.all([Mandi.findOne({ mandiId }), Security.findOne({ mandiId, symbol: input.symbol })]);
  if (!mandi) return { securityId: '', reason: 'Unknown mandi' };
  if (mandi.status !== 'Active') return { securityId: security?.securityId ?? '', reason: `Mandi is ${mandi.status.toLowerCase()}` };
  if (!security) return { securityId: '', reason: 'Security is not listed on this mandi' };
  if (security.status !== 'Listed') return { securityId: security.securityId, reason: `Security is ${security.status.toLowerCase()}` };
  if (!multipleOf(input.quantity, security.lotSize)) return { securityId: security.securityId, reason: `Quantity must be a multiple of lot size ${security.lotSize}` };
  if (!multipleOf(input.price, security.tickSize)) return { securityId: security.securityId, reason: `Price must align to tick size ${security.tickSize}` };
  const deviation = Math.abs(input.price - security.referencePrice);
  if (deviation > security.referencePrice * security.priceBandPct / 100 + 1e-9) return { securityId: security.securityId, reason: `Price is outside the ${security.priceBandPct}% band` };
  return { securityId: security.securityId, reason: '' };
}

async function makeObligations(execution: InstanceType<typeof Execution>, security: InstanceType<typeof Security>, session: ClientSession): Promise<void> {
  const tradeDate = execution.tradeDate;
  const settlementDate = execution.tenor === '1M' ? addBusinessDays(addMonths(tradeDate, 1), 0) : addBusinessDays(tradeDate, security.settlementDays);
  const instrumentCurrency = (await Mandi.findOne({ mandiId: execution.mandiId }).session(session))?.currency ?? 'USD';
  for (const party of [
    { brokerId: execution.buyBrokerId, counterpartyBrokerId: execution.sellBrokerId, side: 'Buy', delivery: 'Receive' },
    { brokerId: execution.sellBrokerId, counterpartyBrokerId: execution.buyBrokerId, side: 'Sell', delivery: 'Deliver' }
  ] as const) {
    const obligationId = await nextId('obligation');
    await Obligation.create([{
      obligationId, executionId: execution.executionId, seq: execution.seq, ...party, securityId: execution.securityId,
      symbol: execution.symbol, mandiId: execution.mandiId, tenor: execution.tenor, quantity: execution.quantity, price: execution.price,
      consideration: Number((execution.quantity * execution.price).toFixed(10)), currency: instrumentCurrency, tradeDate, settlementDate,
      settlementDays: security.settlementDays, depositoryId: security.depositoryId
    }], { session });
    await SettlementInstruction.create([{
      instructionId: await nextId('instruction'), obligationId, executionId: execution.executionId, depositoryId: security.depositoryId,
      brokerId: party.brokerId, symbol: execution.symbol, mandiId: execution.mandiId, delivery: party.delivery,
      quantity: execution.quantity, consideration: Number((execution.quantity * execution.price).toFixed(10)), currency: instrumentCurrency, settlementDate
    }], { session });
  }
}

export async function submitOrder(brokerId: string, raw: unknown, actorId = brokerId): Promise<object> {
  const input = orderInputSchema.parse(raw);
  const duplicate = await ExchangeOrder.findOne({ brokerId, brokerOrderRef: input.brokerOrderRef }).lean();
  if (duplicate) return duplicate;
  const member = await BrokerMember.findOne({ brokerId });
  if (!member || member.status !== 'Active') throw new ApiError(403, member?.statusReason || 'Broker member is not active', 'MEMBER_REFUSED');
  const checked = await rejectReason(input, member.mandiId);
  return inTransaction(async (session) => {
    const orderId = await nextId('order');
    const seq = await nextSequence(session);
    const incoming = (await ExchangeOrder.create([{ orderId, brokerId, ...input, mandiId: member.mandiId, securityId: checked.securityId, seq, status: checked.reason ? 'Rejected' : 'Open', rejectReason: checked.reason }], { session }))[0]!;
    await recordAudit({ realm: 'Exchange', collection: 'orders', recordId: orderId, action: checked.reason ? 'Reject' : 'Accept', actorId, after: incoming.toObject() }, session);
    if (checked.reason) return incoming.toObject();
    const security = await Security.findOne({ securityId: checked.securityId }).session(session);
    if (!security) throw new ApiError(409, 'Security disappeared during order submission');
    let remaining = input.quantity;
    while (remaining > 1e-10) {
      const priceFilter = input.action === 'Buy' ? { $lte: input.price } : { $gte: input.price };
      const sort = input.action === 'Buy' ? { price: 1 as const, seq: 1 as const } : { price: -1 as const, seq: 1 as const };
      const resting = await ExchangeOrder.findOne({ securityId: checked.securityId, tenor: input.tenor, action: input.action === 'Buy' ? 'Sell' : 'Buy', status: { $in: ['Open', 'Partially Executed'] }, price: priceFilter }).sort(sort).session(session);
      if (!resting) break;
      const restingRemaining = Number((resting.quantity - resting.filledQuantity).toFixed(10));
      const quantity = Number(Math.min(remaining, restingRemaining).toFixed(10));
      const execution = (await Execution.create([{
        executionId: await nextId('execution'), seq: await nextSequence(session), securityId: security.securityId, symbol: security.symbol, mandiId: security.mandiId,
        tenor: input.tenor, price: resting.price, quantity,
        buyOrderId: input.action === 'Buy' ? orderId : resting.orderId, sellOrderId: input.action === 'Sell' ? orderId : resting.orderId,
        buyBrokerId: input.action === 'Buy' ? brokerId : resting.brokerId, sellBrokerId: input.action === 'Sell' ? brokerId : resting.brokerId,
        tradeDate: isoDate()
      }], { session }))[0]!;
      resting.filledQuantity = Number((resting.filledQuantity + quantity).toFixed(10));
      resting.status = Math.abs(resting.filledQuantity - resting.quantity) < 1e-10 ? 'Executed' : 'Partially Executed';
      await resting.save({ session });
      incoming.filledQuantity = Number((incoming.filledQuantity + quantity).toFixed(10));
      incoming.status = Math.abs(incoming.filledQuantity - incoming.quantity) < 1e-10 ? 'Executed' : 'Partially Executed';
      await incoming.save({ session });
      await makeObligations(execution, security, session);
      await recordAudit({ realm: 'Exchange', collection: 'executions', recordId: execution.executionId, action: 'Execute', actorId, after: execution.toObject() }, session);
      remaining = Number((remaining - quantity).toFixed(10));
    }
    return incoming.toObject();
  });
}

export async function cancelExchangeOrder(brokerId: string, orderId: string, actorId = brokerId): Promise<object> {
  const order = await ExchangeOrder.findOne({ brokerId, orderId });
  if (!order) throw new ApiError(404, 'Order not found');
  if (!['Open', 'Partially Executed'].includes(order.status)) throw new ApiError(409, `A ${order.status} order cannot be cancelled`, 'INVALID_TRANSITION');
  const before = order.toObject();
  order.status = 'Cancelled';
  await order.save();
  await recordAudit({ realm: 'Exchange', collection: 'orders', recordId: orderId, action: 'Cancel', actorId, before, after: order.toObject() });
  return order.toObject();
}
