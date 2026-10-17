import { ApiError } from '../../common/errors.js';
import { isoDate } from '../../common/dates.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { BrokerExecution, BrokerObligation, BrokerOrder, SecurityReplica } from '../broker/broker.models.js';
import { placeBrokerOrder, syncExchangeFeeds } from '../broker/broker.service.js';
import { CashEntry, DeskAccount, DeskInstrument, DeskObligation, DeskOrder, DeskPrice, DeskTrade } from './desk.models.js';
import { walkPositions, type AccountingTrade } from './position-engine.js';

export interface TradeInput { ticketId?: string | undefined; orderId?: string | undefined; instrumentId: string; action: 'Buy' | 'Sell'; quantity: number; price: number; charges?: number | undefined; currency?: string | undefined; tradeDate: string; settlementDate?: string | undefined; status?: 'Draft' | 'Submitted' | 'Completed' | undefined; tradeOrigin?: 'External' | 'System' | undefined; remarks?: string | undefined; executionId?: string | undefined; }

function cashMovement(trade: { action: string; quantity: number; price: number; charges: number; instrumentId: string }): { amount: number; entryType: 'debit' | 'credit'; description: string } {
  const consideration = trade.quantity * trade.price;
  return trade.action === 'Buy'
    ? { amount: -(consideration + trade.charges), entryType: 'debit', description: `Buy ${trade.quantity} ${trade.instrumentId} @ ${trade.price}` }
    : { amount: consideration - trade.charges, entryType: 'credit', description: `Sell ${trade.quantity} ${trade.instrumentId} @ ${trade.price}` };
}

async function syncTradeCash(trade: InstanceType<typeof DeskTrade>, actorId: string): Promise<void> {
  if (trade.status !== 'Completed') return;
  const movement = cashMovement(trade); const existing = await CashEntry.findOne({ tradeId: trade.tradeId, accountId: trade.accountId, entryType: { $in: ['debit', 'credit'] } });
  if (existing) { const before = existing.toObject(); existing.amount = movement.amount; existing.entryType = movement.entryType; existing.description = movement.description; existing.entryDate = trade.tradeDate; existing.currency = trade.currency; await existing.save(); await recordAudit({ realm: 'Desk', collection: 'cashEntries', recordId: existing.cashId, action: 'Amend', actorId, before, after: existing.toObject() }); }
  else { const entry = await CashEntry.create({ cashId: await nextId('cash'), tradeId: trade.tradeId, accountId: trade.accountId, entryDate: trade.tradeDate, currency: trade.currency, ...movement }); await recordAudit({ realm: 'Desk', collection: 'cashEntries', recordId: entry.cashId, action: 'Create', actorId, after: entry.toObject() }); }
}

export async function recalculateOrder(orderId: string): Promise<void> {
  const order = await DeskOrder.findOne({ orderId }); if (!order || ['Cancelled', 'Rejected'].includes(order.status)) return;
  const trades = await DeskTrade.find({ orderId, accountId: order.accountId, status: 'Completed' }).lean(); const filled = trades.reduce((sum, item) => sum + item.quantity, 0);
  order.status = filled <= 1e-9 ? (order.status === 'Draft' ? 'Draft' : 'Open') : filled + 1e-9 >= order.quantity ? 'Executed' : 'Partially Executed'; await order.save();
}

export async function createTrade(accountId: string, input: TradeInput, actorId: string): Promise<object> {
  if (!await DeskInstrument.exists({ instrumentId: input.instrumentId, active: true })) throw new ApiError(400, 'Instrument does not exist or is inactive');
  if (input.quantity <= 0 || input.price <= 0 || (input.charges ?? 0) < 0) throw new ApiError(400, 'Quantity and price must be positive and charges cannot be negative');
  const tradeId = await nextId('trade');
  const trade = await DeskTrade.create({ tradeId, accountId, ...input, charges: input.charges ?? 0, currency: input.currency ?? 'USD', status: input.status ?? 'Completed', tradeOrigin: input.tradeOrigin ?? 'External' });
  await syncTradeCash(trade, actorId); await recordAudit({ realm: 'Desk', collection: 'trades', recordId: tradeId, action: 'Create', actorId, after: trade.toObject() }); if (trade.orderId) await recalculateOrder(trade.orderId); return trade.toObject();
}

export async function amendTrade(accountId: string, tradeId: string, changes: { quantity?: number | undefined; price?: number | undefined; charges?: number | undefined; currency?: string | undefined; status?: 'Draft' | 'Submitted' | 'Completed' | undefined; remarks?: string | undefined; tradeDate?: string | undefined; settlementDate?: string | undefined }, actorId: string): Promise<object> {
  const trade = await DeskTrade.findOne({ accountId, tradeId }); if (!trade) throw new ApiError(404, 'Trade not found'); if (['Cancelled', 'Reversed'].includes(trade.status)) throw new ApiError(409, `A ${trade.status} trade cannot be amended`);
  if (changes.quantity !== undefined && changes.quantity <= 0 || changes.price !== undefined && changes.price <= 0 || changes.charges !== undefined && changes.charges < 0) throw new ApiError(400, 'Quantity and price must be positive and charges cannot be negative');
  const before = trade.toObject(); Object.assign(trade, changes); await trade.save(); await syncTradeCash(trade, actorId); await recordAudit({ realm: 'Desk', collection: 'trades', recordId: tradeId, action: 'Amend', actorId, before, after: trade.toObject() }); if (trade.orderId) await recalculateOrder(trade.orderId); return trade.toObject();
}

export async function reverseTrade(accountId: string, tradeId: string, reason: string, actorId: string): Promise<object> {
  const trade = await DeskTrade.findOne({ accountId, tradeId }); if (!trade) throw new ApiError(404, 'Trade not found'); if (trade.status !== 'Completed') throw new ApiError(409, `Only a completed trade can be reversed`);
  const before = trade.toObject(); trade.status = 'Reversed'; trade.reversedAt = new Date(); trade.remarks = [trade.remarks, reason].filter(Boolean).join(' — '); await trade.save();
  const entries = await CashEntry.find({ accountId, tradeId, entryType: { $in: ['debit', 'credit'] } }); for (const entry of entries) await CashEntry.create({ cashId: await nextId('cash'), tradeId, accountId, entryDate: entry.entryDate, currency: entry.currency, amount: -entry.amount, entryType: 'reversal', description: `Reversal of ${entry.description}${reason ? ` (${reason})` : ''}` });
  await recordAudit({ realm: 'Desk', collection: 'trades', recordId: tradeId, action: 'Reverse', actorId, before, after: trade.toObject() }); if (trade.orderId) await recalculateOrder(trade.orderId); return trade.toObject();
}

export async function positionsFor(accountId: string): Promise<ReturnType<typeof walkPositions>> {
  const trades = await DeskTrade.find({ accountId, status: 'Completed' }).sort({ tradeDate: 1, createdAt: 1, _id: 1 }).lean();
  return walkPositions(trades.map((item): AccountingTrade => ({ tradeId: item.tradeId, accountId: item.accountId, instrumentId: item.instrumentId, action: item.action, quantity: item.quantity, price: item.price, charges: item.charges, tradeDate: item.tradeDate, createdAt: item.createdAt })));
}

export async function pnlFor(accountId: string): Promise<object> {
  const engine = await positionsFor(accountId); const rows = [];
  for (const position of engine.positions) { const latest = await DeskPrice.findOne({ instrumentId: position.instrumentId, effectiveDate: { $lte: isoDate() } }).sort({ effectiveDate: -1, createdAt: -1 }).lean(); const marketPrice = latest?.price ?? position.averageCost; const marketValue = position.quantity * marketPrice; const unrealizedPnl = marketValue - position.costBasis; rows.push({ ...position, marketPrice, marketValue, unrealizedPnl, totalPnl: position.realizedPnl + unrealizedPnl }); }
  return { positions: rows, events: engine.events, realizedPnl: engine.realizedTotal, unrealizedPnl: rows.reduce((sum, item) => sum + item.unrealizedPnl, 0), totalPnl: rows.reduce((sum, item) => sum + item.totalPnl, 0) };
}

export async function createManualCash(accountId: string, input: { amount: number; entryType: 'deposit' | 'withdrawal' | 'adjustment'; description: string; entryDate?: string | undefined; currency?: string | undefined }, actorId: string): Promise<object> {
  if (input.amount === 0) throw new ApiError(400, 'Amount must not be zero'); if (['deposit', 'withdrawal'].includes(input.entryType) && input.amount < 0) throw new ApiError(400, `A ${input.entryType} must be a positive amount`); if (!input.description.trim()) throw new ApiError(400, 'Description is required');
  const entry = await CashEntry.create({ cashId: await nextId('cash'), accountId, amount: input.entryType === 'withdrawal' ? -Math.abs(input.amount) : input.amount, entryType: input.entryType, description: input.description.trim(), entryDate: input.entryDate ?? isoDate(), currency: input.currency ?? 'USD' }); await recordAudit({ realm: 'Desk', collection: 'cashEntries', recordId: entry.cashId, action: 'Create', actorId, after: entry.toObject() }); return entry.toObject();
}

export async function syncBrokerAccount(traderId: string, accountId: string, actorId: string): Promise<{ trades: number; obligations: number }> {
  await syncExchangeFeeds(); await DeskAccount.findOneAndUpdate({ accountId }, { $setOnInsert: { accountId, label: accountId, traderId } }, { upsert: true });
  const replicas = await SecurityReplica.find().lean(); for (const item of replicas) await DeskInstrument.findOneAndUpdate({ instrumentId: item.securityId }, { $set: { instrumentId: item.securityId, symbol: item.symbol, name: item.name, assetType: item.assetType, currency: item.currency, active: item.listingStatus === 'Listed', mandiId: item.mandiId } }, { upsert: true });
  const executions = await BrokerExecution.find({ traderId, accountId, attributed: true }).sort({ seq: 1 }).lean(); let addedTrades = 0;
  for (const execution of executions) { if (await DeskTrade.exists({ executionId: execution.ownExecutionId })) continue; const order = await BrokerOrder.findOne({ orderId: execution.orderId }).lean(); const deskOrder = order ? await DeskOrder.findOneAndUpdate({ brokerOrderId: order.orderId, accountId }, { $setOnInsert: { orderId: await nextId('order'), instrumentId: (await DeskInstrument.findOne({ symbol: order.symbol }))?.instrumentId ?? order.symbol, action: order.action, quantity: order.quantity, price: order.price, status: 'Open', tradeDate: isoDate(), accountId, brokerOrderId: order.orderId, brokerRoutingStatus: order.routingStatus } }, { upsert: true, new: true }) : null;
    const instrument = await DeskInstrument.findOne({ symbol: execution.symbol }); if (!instrument || !execution.side) continue; await createTrade(accountId, { orderId: deskOrder?.orderId, instrumentId: instrument.instrumentId, action: execution.side, quantity: execution.quantity ?? 0, price: execution.price ?? 0, charges: 0, tradeDate: execution.tradeDate ?? isoDate(), status: 'Completed', tradeOrigin: 'System', remarks: `Exchange fill ${execution.ownExecutionId}`, executionId: execution.ownExecutionId }, actorId); addedTrades += 1; }
  const obligations = await BrokerObligation.find({ traderId, accountId, attributed: true }).lean(); let addedObligations = 0;
  for (const item of obligations) { const trade = await DeskTrade.findOne({ executionId: item.ownExecutionId }).lean(); const instrument = await DeskInstrument.findOne({ symbol: item.symbol }).lean(); const result = await DeskObligation.updateOne({ obligationId: item.obligationId }, { $set: { obligationId: item.obligationId, executionId: item.ownExecutionId, exchangeExecutionId: item.executionId, tradeId: trade?.tradeId ?? '', orderId: item.orderId, seq: item.seq, instrumentId: instrument?.instrumentId ?? item.symbol, action: item.side, quantity: item.quantity, price: item.price, consideration: item.consideration, currency: item.currency, tradeDate: item.tradeDate, settlementDate: item.settlementDate, settlementDays: item.settlementDays, depositoryId: item.depositoryId, cashLeg: item.cashLeg, securityLeg: item.securityLeg, status: item.status, failedReason: item.failedReason, settledAt: item.settledAt, accountId, ingestedAt: new Date() } }, { upsert: true }); if (result.upsertedCount) addedObligations += 1; }
  return { trades: addedTrades, obligations: addedObligations };
}

export async function placeDeskBrokerOrder(traderId: string, accountId: string, input: { instrumentId: string; action: 'Buy' | 'Sell'; quantity: number; price: number; tenor: 'Spot' | '1M'; remarks?: string }, actorId: string): Promise<object> {
  const instrument = await DeskInstrument.findOne({ instrumentId: input.instrumentId, active: true }); if (!instrument) throw new ApiError(400, 'Instrument is not active'); const orderId = await nextId('order');
  const deskOrder = await DeskOrder.create({ orderId, accountId, ...input, tradeDate: isoDate(), status: 'Open' }); const brokerOrder = await placeBrokerOrder(traderId, { symbol: instrument.symbol, action: input.action, quantity: input.quantity, price: input.price, tenor: input.tenor, clientRef: orderId }) as Record<string, unknown>; deskOrder.brokerOrderId = String(brokerOrder.orderId ?? ''); deskOrder.brokerRoutingStatus = String(brokerOrder.routingStatus ?? ''); if (brokerOrder.exchangeStatus) deskOrder.status = String(brokerOrder.exchangeStatus) as typeof deskOrder.status; await deskOrder.save(); await recordAudit({ realm: 'Desk', collection: 'orders', recordId: orderId, action: 'Route', actorId, after: deskOrder.toObject() }); return deskOrder.toObject();
}
