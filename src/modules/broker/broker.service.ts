import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { Counter } from '../../common/models.js';
import { recordAudit } from '../audit/audit.service.js';
import { ExchangeLot, Execution, Obligation, Security } from '../exchange/exchange.models.js';
import { cancelExchangeOrder, submitOrder } from '../exchange/matching.service.js';
import { CustodyLot } from '../storage/storage.models.js';
import { BrokerExecution, BrokerObligation, BrokerOrder, BrokerProfile, Enlistment, SecurityReplica, Trader } from './broker.models.js';

async function nextBrokerSequence(): Promise<number> {
  return (await Counter.findOneAndUpdate({ name: 'broker-order-sequence' }, { $inc: { value: 1 } }, { upsert: true, new: true })).value;
}

export async function refreshSecurities(actorId: string): Promise<number> {
  const profile = await BrokerProfile.findOne({ profileId: 'default' }); if (!profile) throw new ApiError(409, 'Configure the broker exchange membership first');
  const securities = await Security.find({ mandiId: profile.mandiId }).lean();
  for (const item of securities) await SecurityReplica.findOneAndUpdate({ securityId: item.securityId }, { $set: { securityId: item.securityId, symbol: item.symbol, name: item.symbol, assetType: 'Security', currency: 'USD', mandiId: item.mandiId, tickSize: item.tickSize, lotSize: item.lotSize, priceBandPct: item.priceBandPct, referencePrice: item.referencePrice, settlementDays: item.settlementDays, depositoryId: item.depositoryId, listingStatus: item.status, replicatedAt: new Date() } }, { upsert: true });
  await SecurityReplica.deleteMany({ mandiId: profile.mandiId, securityId: { $nin: securities.map((item) => item.securityId) } });
  await recordAudit({ realm: 'Broker', collection: 'securities', recordId: profile.mandiId, action: 'Refresh', actorId, metadata: { count: securities.length } });
  return securities.length;
}

export async function routeBrokerOrder(orderId: string, actorId: string): Promise<object> {
  const order = await BrokerOrder.findOne({ orderId }); if (!order) throw new ApiError(404, 'Broker order not found');
  if (!['Pending', 'Unrouted', 'Refused'].includes(order.routingStatus)) throw new ApiError(409, `A ${order.routingStatus} order is not retryable`);
  const profile = await BrokerProfile.findOne({ profileId: 'default' }); if (!profile) throw new ApiError(409, 'Broker exchange membership is not configured');
  order.routeAttempts += 1;
  try {
    const exchangeOrder = await submitOrder(profile.exchangeBrokerId, { brokerOrderRef: order.orderId, symbol: order.symbol, action: order.action, quantity: order.quantity, price: order.price, tenor: order.tenor }, actorId) as Record<string, unknown>;
    order.exchangeOrderId = String(exchangeOrder.orderId ?? ''); order.exchangeStatus = String(exchangeOrder.status ?? '');
    if (exchangeOrder.status === 'Rejected') { order.routingStatus = 'Rejected'; order.rejectReason = String(exchangeOrder.rejectReason ?? 'Order rejected'); }
    else { order.routingStatus = 'Routed'; order.routedAt = new Date(); order.routeReason = ''; }
    await order.save();
    await recordAudit({ realm: 'Broker', collection: 'orders', recordId: order.orderId, action: `Routing ${order.routingStatus}`, actorId, after: order.toObject() });
    if (order.routingStatus === 'Routed' && exchangeOrder.status === 'Open' && profile.principalStepIn && !order.principalAttempted) {
      order.principalAttempted = true; await order.save();
      try { await submitOrder(profile.exchangeBrokerId, { brokerOrderRef: `BKPR-${order.orderId}`, symbol: order.symbol, action: order.action === 'Buy' ? 'Sell' : 'Buy', quantity: order.quantity, price: order.price, tenor: order.tenor }, actorId); }
      catch (error) { order.routeReason = `Step-in failed: ${error instanceof Error ? error.message : 'unknown error'}`; await order.save(); }
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'MEMBER_REFUSED') { order.routingStatus = 'Refused'; order.routeReason = error.message; }
    else { order.routingStatus = 'Unrouted'; order.routeReason = error instanceof Error ? error.message : 'Exchange delivery failed'; }
    await order.save(); await recordAudit({ realm: 'Broker', collection: 'orders', recordId: order.orderId, action: `Routing ${order.routingStatus}`, actorId, after: order.toObject() });
  }
  await syncExchangeFeeds();
  return order.toObject();
}

export async function placeBrokerOrder(traderId: string, input: { symbol: string; action: 'Buy' | 'Sell'; quantity: number; price: number; clientRef?: string | undefined; tenor: 'Spot' | '1M' }): Promise<object> {
  const trader = await Trader.findOne({ traderId }); if (!trader || trader.status !== 'Active') throw new ApiError(403, trader?.statusReason || 'Trader cannot place orders', 'TRADING_REFUSED');
  if (input.clientRef) { const duplicate = await BrokerOrder.findOne({ traderId, clientRef: input.clientRef }); if (duplicate) return duplicate.toObject(); }
  const security = await SecurityReplica.findOne({ symbol: input.symbol.toUpperCase(), listingStatus: 'Listed' }); if (!security) throw new ApiError(400, 'Symbol is not available in the broker security replica');
  const order = await BrokerOrder.create({ orderId: await nextId('order'), traderId, accountId: trader.accountId, ...input, symbol: input.symbol.toUpperCase(), seq: await nextBrokerSequence() });
  await recordAudit({ realm: 'Broker', collection: 'orders', recordId: order.orderId, action: 'Receive', actorId: traderId, after: order.toObject() });
  return routeBrokerOrder(order.orderId, traderId);
}

export async function cancelBrokerOrder(orderId: string, traderId: string, actorId: string): Promise<object> {
  const order = await BrokerOrder.findOne({ orderId, ...(traderId ? { traderId } : {}) }); if (!order) throw new ApiError(404, 'Order not found');
  if (order.routingStatus !== 'Routed' || !order.exchangeOrderId) throw new ApiError(409, `Order was not accepted by the exchange; routing status is ${order.routingStatus}`);
  const profile = await BrokerProfile.findOne({ profileId: 'default' }); if (!profile) throw new ApiError(409, 'Broker is not configured');
  const exchangeOrder = await cancelExchangeOrder(profile.exchangeBrokerId, order.exchangeOrderId, actorId) as Record<string, unknown>;
  order.exchangeStatus = String(exchangeOrder.status ?? 'Cancelled'); await order.save(); await recordAudit({ realm: 'Broker', collection: 'orders', recordId: orderId, action: 'Cancel', actorId, after: order.toObject() }); return order.toObject();
}

export async function retryPending(actorId: string): Promise<{ attempted: number; routed: string[]; failed: Array<[string, string]> }> {
  const orders = await BrokerOrder.find({ routingStatus: { $in: ['Pending', 'Unrouted', 'Refused'] } }).sort({ seq: 1 }).limit(100); const routed: string[] = []; const failed: Array<[string, string]> = [];
  for (const order of orders) { const result = await routeBrokerOrder(order.orderId, actorId) as { routingStatus?: string }; if (result.routingStatus === 'Routed') routed.push(order.orderId); else failed.push([order.orderId, result.routingStatus ?? 'Failed']); }
  return { attempted: orders.length, routed, failed };
}

export async function syncExchangeFeeds(): Promise<void> {
  const profile = await BrokerProfile.findOne({ profileId: 'default' }); if (!profile) return;
  const executions = await Execution.find({ seq: { $gt: profile.executionCursor }, $or: [{ buyBrokerId: profile.exchangeBrokerId }, { sellBrokerId: profile.exchangeBrokerId }] }).sort({ seq: 1 }).lean();
  for (const execution of executions) {
    const sides = [] as Array<{ side: 'Buy' | 'Sell'; ownOrderId: string; counterpartyOrderId: string; counterpartyBrokerId: string }>;
    if (execution.buyBrokerId === profile.exchangeBrokerId) sides.push({ side: 'Buy', ownOrderId: execution.buyOrderId, counterpartyOrderId: execution.sellOrderId, counterpartyBrokerId: execution.sellBrokerId });
    if (execution.sellBrokerId === profile.exchangeBrokerId) sides.push({ side: 'Sell', ownOrderId: execution.sellOrderId, counterpartyOrderId: execution.buyOrderId, counterpartyBrokerId: execution.buyBrokerId });
    for (const [index, side] of sides.entries()) { const order = await BrokerOrder.findOne({ exchangeOrderId: side.ownOrderId }); const ownExecutionId = index === 0 ? execution.executionId : `${execution.executionId}:cp`; await BrokerExecution.updateOne({ ownExecutionId }, { $setOnInsert: { ownExecutionId, executionId: execution.executionId, seq: execution.seq, symbol: execution.symbol, tenor: execution.tenor, price: execution.price, quantity: execution.quantity, ...side, tradeDate: execution.tradeDate, executedAt: execution.executedAt, orderId: order?.orderId ?? '', traderId: order?.traderId ?? '', accountId: order?.accountId ?? '', attributed: Boolean(order) } }, { upsert: true }); }
    profile.executionCursor = Math.max(profile.executionCursor, execution.seq);
  }
  const obligations = await Obligation.find({ brokerId: profile.exchangeBrokerId, seq: { $gt: profile.obligationCursor } }).sort({ seq: 1 }).lean();
  for (const item of obligations) { const execution = await BrokerExecution.findOne({ executionId: item.executionId, side: item.side }); await BrokerObligation.updateOne({ obligationId: item.obligationId }, { $set: { ...item, ownExecutionId: execution?.ownExecutionId ?? '', ownOrderId: execution?.ownOrderId ?? '', orderId: execution?.orderId ?? '', traderId: execution?.traderId ?? '', accountId: execution?.accountId ?? '', attributed: Boolean(execution?.attributed), ingestedAt: new Date() } }, { upsert: true }); profile.obligationCursor = Math.max(profile.obligationCursor, item.seq); }
  await profile.save();
}

export async function enlistDeclaration(enlistmentId: string, actorId: string): Promise<object> {
  const item = await Enlistment.findOne({ enlistmentId }); if (!item) throw new ApiError(404, 'Enlistment not found'); if (item.status === 'Enlisted') throw new ApiError(409, 'Declaration is already enlisted');
  const profile = await BrokerProfile.findOne({ profileId: 'default' }); if (!profile) throw new ApiError(409, 'Broker is not configured');
  for (const requested of item.lots) { const custody = await CustodyLot.findOne({ lotId: requested.lotId, ownerId: profile.exchangeBrokerId, depositoryId: item.depositoryId, securityId: item.securityId, status: 'Held' }); if (!custody || Math.abs(custody.weight - (requested.weight ?? 0)) > 1e-8) throw new ApiError(409, `Lot ${requested.lotId ?? ''} is not valid custody inventory`); }
  await ExchangeLot.insertMany(item.lots.map((lot) => ({ lotId: lot.lotId, securityId: item.securityId, symbol: item.symbol, depositoryId: item.depositoryId, ownerBrokerId: profile.exchangeBrokerId, weight: lot.weight })));
  item.status = 'Enlisted'; item.enlistedAt = new Date(); await item.save(); await recordAudit({ realm: 'Broker', collection: 'enlistments', recordId: item.enlistmentId, action: 'Enlist', actorId, after: item.toObject() }); return item.toObject();
}
