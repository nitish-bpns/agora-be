import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { isoDate } from '../../common/dates.js';
import { asyncHandler, parse } from '../../common/http.js';
import { nextId } from '../../common/ids.js';
import { AuditEvent } from '../audit/audit.model.js';
import { recordAudit } from '../audit/audit.service.js';
import { verifyAccessToken } from '../auth/auth.service.js';
import { resolveTraderSession } from '../broker/broker-auth.service.js';
import { CashEntry, BrokerConnection, DeskAccount, DeskInstrument, DeskObligation, DeskOrder, DeskPrice, DeskTicket, DeskTrade } from './desk.models.js';
import { amendTrade, createManualCash, createTrade, placeDeskBrokerOrder, pnlFor, positionsFor, reverseTrade, syncBrokerAccount } from './desk.service.js';
import { walkPositions } from './position-engine.js';

const deskAuthenticate: RequestHandler = async (req, _res, next) => {
  const token = req.header('authorization')?.replace(/^Bearer /, '') ?? req.header('x-session-token') ?? '';
  try {
    try { const claims = verifyAccessToken(token); if (claims.realm !== 'Desk') throw new ApiError(403, 'This identity cannot access the desk'); req.auth = { subject: claims.sub, kind: 'operator', realm: 'Desk', role: claims.role, accountId: String(req.header('x-account-id') ?? req.query.accountId ?? 'ACC-LOCAL') }; }
    catch { const trader = await resolveTraderSession(token); req.auth = { subject: trader.traderId, kind: 'trader', realm: 'Broker', role: 'Trader', traderId: trader.traderId, accountId: trader.accountId }; }
    next();
  } catch (error) { next(error); }
};
const canWrite: RequestHandler = (req, _res, next) => req.auth?.role !== 'Read-only' ? next() : next(new ApiError(403, 'Read-only users cannot modify the book'));
const account = (req: Express.Request): string => req.auth?.accountId ?? 'ACC-LOCAL';

export const deskRouter = Router();
deskRouter.use(deskAuthenticate);

deskRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const accountId = account(req); const [trades, orders, cash, pnl, obligations] = await Promise.all([DeskTrade.countDocuments({ accountId }), DeskOrder.countDocuments({ accountId, status: { $in: ['Draft', 'Open', 'Partially Executed'] } }), CashEntry.aggregate([{ $match: { accountId } }, { $group: { _id: null, balance: { $sum: '$amount' } } }]), pnlFor(accountId), DeskObligation.countDocuments({ accountId, status: 'Unsettled' })]);
  res.json({ trades, openOrders: orders, cashBalance: cash[0]?.balance ?? 0, pnl, unsettledObligations: obligations });
}));
deskRouter.post('/sync', canWrite, asyncHandler(async (req, res) => { if (!req.auth!.traderId) throw new ApiError(409, 'A signed-in broker trader is required to synchronize'); res.json(await syncBrokerAccount(req.auth!.traderId, account(req), req.auth!.subject)); }));

deskRouter.get('/instruments', asyncHandler(async (_req, res) => res.json({ items: await DeskInstrument.find().sort({ symbol: 1 }).lean() })));
deskRouter.post('/instruments', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ symbol: z.string().min(1), name: z.string().min(1), assetType: z.string().default('Equity'), currency: z.string().length(3).default('USD') }), req.body); const item = await DeskInstrument.create({ instrumentId: await nextId('instrument'), ...body, symbol: body.symbol.toUpperCase() }); await recordAudit({ realm: 'Desk', collection: 'instruments', recordId: item.instrumentId, action: 'Create', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json(item); }));
deskRouter.patch('/instruments/:instrumentId', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ name: z.string().min(1).optional(), active: z.boolean().optional() }), req.body); const item = await DeskInstrument.findOne({ instrumentId: req.params.instrumentId }); if (!item) throw new ApiError(404, 'Instrument not found'); const before = item.toObject(); Object.assign(item, body); await item.save(); await recordAudit({ realm: 'Desk', collection: 'instruments', recordId: item.instrumentId, action: body.active === false ? 'Deactivate' : 'Update', actorId: req.auth!.subject, before, after: item.toObject() }); res.json(item); }));

deskRouter.get('/tickets', asyncHandler(async (req, res) => res.json({ items: await DeskTicket.find({ accountId: account(req) }).sort({ createdAt: -1 }).lean() })));
deskRouter.post('/tickets', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ tradeOrigin: z.enum(['External', 'System']).default('External'), description: z.string().default('') }), req.body); const item = await DeskTicket.create({ ticketId: await nextId('ticket'), accountId: account(req), ...body }); await recordAudit({ realm: 'Desk', collection: 'tickets', recordId: item.ticketId, action: 'Create', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json(item); }));

const orderBody = z.object({ instrumentId: z.string().min(1), action: z.enum(['Buy', 'Sell']), quantity: z.number().positive(), price: z.number().positive(), tenor: z.enum(['Spot', '1M']).default('Spot'), remarks: z.string().default(''), status: z.enum(['Draft', 'Open']).default('Draft') });
deskRouter.get('/orders', asyncHandler(async (req, res) => res.json({ items: await DeskOrder.find({ accountId: account(req) }).sort({ createdAt: -1 }).lean() })));
deskRouter.post('/orders', canWrite, asyncHandler(async (req, res) => { const body = parse(orderBody, req.body); if (req.auth!.traderId && body.status === 'Open') { res.status(201).json(await placeDeskBrokerOrder(req.auth!.traderId, account(req), body, req.auth!.subject)); return; } const order = await DeskOrder.create({ orderId: await nextId('order'), accountId: account(req), ...body, tradeDate: isoDate() }); await recordAudit({ realm: 'Desk', collection: 'orders', recordId: order.orderId, action: 'Create', actorId: req.auth!.subject, after: order.toObject() }); res.status(201).json(order); }));
deskRouter.patch('/orders/:orderId/status', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ status: z.enum(['Open', 'Cancelled', 'Rejected']), reason: z.string().default('') }), req.body); const item = await DeskOrder.findOne({ accountId: account(req), orderId: req.params.orderId }); if (!item) throw new ApiError(404, 'Order not found'); const transitions: Record<string, string[]> = { Draft: ['Open', 'Cancelled', 'Rejected'], Open: ['Cancelled', 'Rejected'], 'Partially Executed': ['Cancelled', 'Rejected'], Executed: [], Cancelled: [], Rejected: [] }; if (!transitions[item.status]?.includes(body.status)) throw new ApiError(409, `Transition ${item.status} to ${body.status} is not allowed`); item.status = body.status; item.remarks = [item.remarks, body.reason].filter(Boolean).join(' — '); await item.save(); res.json(item); }));

const tradeBody = z.object({ ticketId: z.string().optional(), orderId: z.string().optional(), instrumentId: z.string().min(1), action: z.enum(['Buy', 'Sell']), quantity: z.number().positive(), price: z.number().positive(), charges: z.number().nonnegative().default(0), currency: z.string().length(3).default('USD'), tradeDate: z.string().date(), settlementDate: z.string().date().optional(), status: z.enum(['Draft', 'Submitted', 'Completed']).default('Completed'), tradeOrigin: z.enum(['External', 'System']).default('External'), remarks: z.string().default('') });
deskRouter.get('/trades', asyncHandler(async (req, res) => { const filter: Record<string, unknown> = { accountId: account(req) }; for (const key of ['instrumentId', 'status', 'action', 'orderId'] as const) if (req.query[key]) filter[key] = req.query[key]; res.json({ items: await DeskTrade.find(filter).sort({ tradeDate: -1, createdAt: -1 }).lean() }); }));
deskRouter.post('/trades', canWrite, asyncHandler(async (req, res) => res.status(201).json(await createTrade(account(req), parse(tradeBody, req.body), req.auth!.subject))));
deskRouter.patch('/trades/:tradeId', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ quantity: z.number().positive().optional(), price: z.number().positive().optional(), charges: z.number().nonnegative().optional(), currency: z.string().length(3).optional(), tradeDate: z.string().date().optional(), settlementDate: z.string().date().optional(), status: z.enum(['Draft', 'Submitted', 'Completed']).optional(), remarks: z.string().optional() }), req.body); res.json(await amendTrade(account(req), String(req.params.tradeId ?? ''), body, req.auth!.subject)); }));
deskRouter.post('/trades/:tradeId/reverse', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ reason: z.string().min(1) }), req.body); res.json(await reverseTrade(account(req), String(req.params.tradeId ?? ''), body.reason, req.auth!.subject)); }));
deskRouter.post('/trades/simulate', asyncHandler(async (req, res) => { const body = parse(tradeBody, req.body); const existing = await DeskTrade.find({ accountId: account(req), status: 'Completed' }).sort({ tradeDate: 1, createdAt: 1 }).lean(); const result = walkPositions([...existing.map((item) => ({ tradeId: item.tradeId, accountId: item.accountId, instrumentId: item.instrumentId, action: item.action, quantity: item.quantity, price: item.price, charges: item.charges, tradeDate: item.tradeDate })), { ...body, tradeId: '__SIMULATED__', accountId: account(req) }].sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)))); res.json(result); }));

deskRouter.get('/holdings', asyncHandler(async (req, res) => { const includeClosed = req.query.includeClosed === 'true'; const result = await positionsFor(account(req)); res.json({ ...result, positions: result.positions.filter((item) => includeClosed || item.isOpen) }); }));
deskRouter.get('/pnl', asyncHandler(async (req, res) => res.json(await pnlFor(account(req)))));

deskRouter.get('/cash', asyncHandler(async (req, res) => { const items = await CashEntry.find({ accountId: account(req) }).sort({ entryDate: 1, createdAt: 1 }).lean(); let running = 0; res.json({ items: items.map((item) => ({ ...item, runningBalance: running = Number((running + item.amount).toFixed(2)) })), balance: running }); }));
deskRouter.post('/cash', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ amount: z.number(), entryType: z.enum(['deposit', 'withdrawal', 'adjustment']), description: z.string().min(1), entryDate: z.string().date().optional(), currency: z.string().length(3).optional() }), req.body); res.status(201).json(await createManualCash(account(req), body, req.auth!.subject)); }));

deskRouter.get('/prices', asyncHandler(async (_req, res) => res.json({ items: await DeskPrice.find().sort({ effectiveDate: -1, instrumentId: 1 }).lean() })));
deskRouter.post('/prices', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ instrumentId: z.string().min(1), price: z.number().positive(), effectiveDate: z.string().date().default(isoDate()) }), req.body); if (!await DeskInstrument.exists({ instrumentId: body.instrumentId })) throw new ApiError(404, 'Instrument not found'); const item = await DeskPrice.findOneAndUpdate({ instrumentId: body.instrumentId, effectiveDate: body.effectiveDate }, { $set: body }, { upsert: true, new: true }); await recordAudit({ realm: 'Desk', collection: 'prices', recordId: `${body.instrumentId}:${body.effectiveDate}`, action: 'Upsert', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json(item); }));
deskRouter.delete('/prices/:id', canWrite, asyncHandler(async (req, res) => { const item = await DeskPrice.findByIdAndDelete(req.params.id); if (!item) throw new ApiError(404, 'Price not found'); await recordAudit({ realm: 'Desk', collection: 'prices', recordId: String(item._id), action: 'Delete', actorId: req.auth!.subject, before: item.toObject() }); res.status(204).end(); }));

deskRouter.get('/obligations', asyncHandler(async (req, res) => res.json({ items: await DeskObligation.find({ accountId: account(req) }).sort({ seq: -1 }).lean() })));
deskRouter.get('/reports/:report', asyncHandler(async (req, res) => { const accountId = account(req); const report = String(req.params.report ?? ''); const reports: Record<string, () => Promise<unknown>> = { trades: () => DeskTrade.find({ accountId }).sort({ tradeDate: -1 }).lean(), orders: () => DeskOrder.find({ accountId }).sort({ createdAt: -1 }).lean(), cash: async () => { const items = await CashEntry.find({ accountId }).sort({ entryDate: 1 }).lean(); let balance = 0; return items.map((item) => ({ ...item, runningBalance: balance += item.amount })); }, holdings: async () => (await positionsFor(accountId)).positions, pnl: () => pnlFor(accountId), realized: async () => (await positionsFor(accountId)).events, settlement: () => DeskObligation.find({ accountId }).sort({ seq: -1 }).lean() }; const loader = reports[report]; if (!loader) throw new ApiError(404, 'Unknown report'); res.json({ report, generatedAt: new Date(), data: await loader() }); }));

deskRouter.get('/settings/accounts', asyncHandler(async (_req, res) => res.json({ items: await DeskAccount.find().lean() })));
deskRouter.get('/settings/connections', asyncHandler(async (_req, res) => res.json({ items: await BrokerConnection.find().lean() })));
deskRouter.post('/settings/connections', canWrite, asyncHandler(async (req, res) => { const body = parse(z.object({ label: z.string().min(1), brokerProfileId: z.string().default('default'), mandiId: z.string().default(''), mandiCode: z.string().default(''), brokerCode: z.string().default(''), isDefault: z.boolean().default(false) }), req.body); const item = await BrokerConnection.create({ connectionId: `BRC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, ...body }); res.status(201).json(item); }));
deskRouter.get('/audit', asyncHandler(async (_req, res) => res.json({ items: await AuditEvent.find({ realm: 'Desk' }).sort({ createdAt: -1 }).limit(500).lean() })));
