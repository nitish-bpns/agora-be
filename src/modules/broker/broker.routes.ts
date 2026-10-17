import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { businessDaysBetween, isoDate } from '../../common/dates.js';
import { asyncHandler, pagination, parse } from '../../common/http.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { authenticate, authorize, requireRealm } from '../auth/auth.middleware.js';
import { Operator } from '../auth/auth.model.js';
import { ExchangeOrder } from '../exchange/exchange.models.js';
import { canTrade, traderAuthenticate } from './broker-auth.middleware.js';
import { endTraderSessions, loginTrader, logoutTrader } from './broker-auth.service.js';
import { BrokerExecution, BrokerObligation, BrokerOrder, BrokerProfile, Enlistment, SecurityReplica, Trader, TraderSession } from './broker.models.js';
import { cancelBrokerOrder, enlistDeclaration, placeBrokerOrder, refreshSecurities, retryPending, routeBrokerOrder, syncExchangeFeeds } from './broker.service.js';

export const brokerRouter = Router();
brokerRouter.use(authenticate, requireRealm('Broker'), authorize('Admin', 'Operations', 'Read-only'));
const write = authorize('Admin', 'Operations');

brokerRouter.get('/dashboard', asyncHandler(async (_req, res) => {
  await syncExchangeFeeds(); const [activeTraders, totalOrders, routed, stuck, rejected, executions, openObligations] = await Promise.all([Trader.countDocuments({ status: 'Active' }), BrokerOrder.countDocuments(), BrokerOrder.countDocuments({ routingStatus: 'Routed' }), BrokerOrder.countDocuments({ routingStatus: { $in: ['Pending', 'Unrouted', 'Refused'] } }), BrokerOrder.countDocuments({ routingStatus: 'Rejected' }), BrokerExecution.countDocuments(), BrokerObligation.countDocuments({ status: 'Unsettled' })]);
  res.json({ activeTraders, totalOrders, routed, stuck, rejected, executions, openObligations });
}));
brokerRouter.get('/profile', asyncHandler(async (_req, res) => res.json({ profile: await BrokerProfile.findOne({ profileId: 'default' }).lean() })));
brokerRouter.put('/profile', authorize('Admin'), asyncHandler(async (req, res) => { const body = parse(z.object({ exchangeBrokerId: z.string().min(1), mandiId: z.string().min(1), principalStepIn: z.boolean().default(false) }), req.body); const profile = await BrokerProfile.findOneAndUpdate({ profileId: 'default' }, { $set: body }, { upsert: true, new: true }); res.json(profile); }));

brokerRouter.get('/traders', asyncHandler(async (_req, res) => res.json({ items: await Trader.find().sort({ createdAt: -1 }).lean() })));
brokerRouter.post('/traders', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(3), displayName: z.string().min(1), email: z.string().email().or(z.literal('')).default(''), password: z.string().min(8) }), req.body);
  if (await Operator.exists({ username: body.username.toLowerCase() })) throw new ApiError(409, 'Username is already assigned to an operator', 'DUPLICATE_USERNAME');
  const trader = await Trader.create({ traderId: await nextId('trader'), accountId: await nextId('account'), ...body, username: body.username.toLowerCase(), passwordHash: await bcrypt.hash(body.password, 12) }); await recordAudit({ realm: 'Broker', collection: 'traders', recordId: trader.traderId, action: 'Register', actorId: req.auth!.subject, after: trader.toObject() }); res.status(201).json({ traderId: trader.traderId, accountId: trader.accountId, username: trader.username, status: trader.status });
}));
brokerRouter.patch('/traders/:traderId/status', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['Active', 'Suspended', 'Closed']), reason: z.string().default('') }), req.body); const trader = await Trader.findOne({ traderId: req.params.traderId }); if (!trader) throw new ApiError(404, 'Trader not found');
  const allowed: Record<string, string[]> = { Active: ['Suspended', 'Closed'], Suspended: ['Active', 'Closed'], Closed: [] }; if (!allowed[trader.status]?.includes(body.status)) throw new ApiError(409, `Transition ${trader.status} to ${body.status} is not allowed`);
  const before = trader.toObject(); trader.status = body.status; trader.statusReason = body.reason; await trader.save(); await endTraderSessions(trader.traderId); await recordAudit({ realm: 'Broker', collection: 'traders', recordId: trader.traderId, action: 'Status', actorId: req.auth!.subject, before, after: trader.toObject() }); res.json(trader);
}));
brokerRouter.post('/traders/:traderId/password', write, asyncHandler(async (req, res) => { const body = parse(z.object({ password: z.string().min(8) }), req.body); const trader = await Trader.findOne({ traderId: req.params.traderId }).select('+passwordHash'); if (!trader) throw new ApiError(404, 'Trader not found'); trader.passwordHash = await bcrypt.hash(body.password, 12); await trader.save(); await endTraderSessions(trader.traderId); res.status(204).end(); }));
brokerRouter.get('/traders/:traderId/activity', asyncHandler(async (req, res) => { const traderId = req.params.traderId; const [orders, executions, obligations, sessions] = await Promise.all([BrokerOrder.find({ traderId }).sort({ seq: -1 }).lean(), BrokerExecution.find({ traderId }).sort({ seq: -1 }).lean(), BrokerObligation.find({ traderId }).sort({ seq: -1 }).lean(), TraderSession.find({ traderId }).sort({ createdAt: -1 }).lean()]); res.json({ orders, executions, obligations, sessions }); }));

brokerRouter.post('/securities/refresh', write, asyncHandler(async (req, res) => res.json({ count: await refreshSecurities(req.auth!.subject) })));
brokerRouter.get('/securities', asyncHandler(async (_req, res) => res.json({ items: await SecurityReplica.find().sort({ symbol: 1 }).lean() })));
brokerRouter.get('/orders', asyncHandler(async (req, res) => { const { page, limit, skip } = pagination(req.query); const filter: Record<string, unknown> = {}; for (const key of ['symbol', 'routingStatus', 'traderId'] as const) if (req.query[key]) filter[key] = req.query[key]; const [items, total] = await Promise.all([BrokerOrder.find(filter).sort({ seq: -1 }).skip(skip).limit(limit).lean(), BrokerOrder.countDocuments(filter)]); res.json({ items, total, page, limit }); }));
brokerRouter.post('/orders/:orderId/retry', write, asyncHandler(async (req, res) => res.json(await routeBrokerOrder(String(req.params.orderId ?? ''), req.auth!.subject))));
brokerRouter.post('/orders/retry-all', write, asyncHandler(async (req, res) => res.json(await retryPending(req.auth!.subject))));
brokerRouter.post('/feeds/sync', write, asyncHandler(async (_req, res) => { await syncExchangeFeeds(); res.status(204).end(); }));
brokerRouter.get('/executions', asyncHandler(async (req, res) => { await syncExchangeFeeds(); const filter = req.query.attributed === 'false' ? { attributed: false } : {}; res.json({ items: await BrokerExecution.find(filter).sort({ seq: -1 }).lean() }); }));
brokerRouter.get('/obligations', asyncHandler(async (req, res) => { await syncExchangeFeeds(); const filter: Record<string, unknown> = {}; for (const key of ['status', 'traderId', 'side'] as const) if (req.query[key]) filter[key] = req.query[key]; const today = isoDate(); const items = await BrokerObligation.find(filter).sort({ settlementDate: 1 }).lean(); res.json({ items: items.map((item) => ({ ...item, isOverdue: item.status === 'Unsettled' && String(item.settlementDate) < today, daysLate: String(item.settlementDate) < today ? businessDaysBetween(String(item.settlementDate), today) : 0 })) }); }));
brokerRouter.get('/enlistments', asyncHandler(async (_req, res) => res.json({ items: await Enlistment.find().sort({ createdAt: -1 }).lean() })));
brokerRouter.post('/enlistments/:enlistmentId/enlist', write, asyncHandler(async (req, res) => res.json(await enlistDeclaration(String(req.params.enlistmentId ?? ''), req.auth!.subject))));

export const traderRouter = Router();
traderRouter.post('/auth/login', asyncHandler(async (req, res) => { const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body); res.json(await loginTrader(body.username, body.password)); }));
traderRouter.post('/auth/logout', traderAuthenticate, asyncHandler(async (req, res) => { const token = req.header('x-session-token') ?? req.header('authorization')!.slice(7); await logoutTrader(token); res.status(204).end(); }));
traderRouter.get('/me', traderAuthenticate, asyncHandler(async (req, res) => { const trader = await Trader.findOne({ traderId: req.auth!.traderId }).lean(); res.json({ trader, canTrade: trader?.status === 'Active', reason: trader?.statusReason ?? '' }); }));
traderRouter.get('/securities', traderAuthenticate, asyncHandler(async (req, res) => { const search = String(req.query.search ?? ''); res.json({ items: await SecurityReplica.find(search ? { $or: [{ symbol: { $regex: search, $options: 'i' } }, { name: { $regex: search, $options: 'i' } }] } : {}).sort({ symbol: 1 }).lean() }); }));
traderRouter.get('/book', traderAuthenticate, asyncHandler(async (req, res) => { const profile = await BrokerProfile.findOne({ profileId: 'default' }); const symbol = String(req.query.symbol ?? '').toUpperCase(); const open = { mandiId: profile?.mandiId, symbol, status: { $in: ['Open', 'Partially Executed'] } }; res.json({ symbol, bids: await ExchangeOrder.find({ ...open, action: 'Buy' }).sort({ price: -1, seq: 1 }).lean(), asks: await ExchangeOrder.find({ ...open, action: 'Sell' }).sort({ price: 1, seq: 1 }).lean() }); }));
traderRouter.get('/orders', traderAuthenticate, asyncHandler(async (req, res) => res.json({ items: await BrokerOrder.find({ traderId: req.auth!.traderId }).sort({ seq: -1 }).lean() })));
traderRouter.post('/orders', traderAuthenticate, canTrade, asyncHandler(async (req, res) => { const body = parse(z.object({ symbol: z.string().min(1), action: z.enum(['Buy', 'Sell']), quantity: z.number().positive().max(1_000_000), price: z.number().positive(), clientRef: z.string().min(1).optional(), tenor: z.enum(['Spot', '1M']).default('Spot') }), req.body); res.json(await placeBrokerOrder(req.auth!.traderId!, body)); }));
traderRouter.get('/order', traderAuthenticate, asyncHandler(async (req, res) => { const item = await BrokerOrder.findOne({ traderId: req.auth!.traderId, orderId: req.query.order_id }); if (!item) throw new ApiError(404, 'Order not found'); res.json(item); }));
traderRouter.post('/orders/cancel', traderAuthenticate, canTrade, asyncHandler(async (req, res) => { const body = parse(z.object({ orderId: z.string().min(1) }), req.body); res.json(await cancelBrokerOrder(body.orderId, req.auth!.traderId!, req.auth!.subject)); }));
traderRouter.get('/executions', traderAuthenticate, asyncHandler(async (req, res) => { await syncExchangeFeeds(); const since = Number(req.query.since ?? 0); res.json({ items: await BrokerExecution.find({ traderId: req.auth!.traderId, seq: { $gt: since } }).sort({ seq: 1 }).lean() }); }));
traderRouter.get('/obligations', traderAuthenticate, asyncHandler(async (req, res) => { await syncExchangeFeeds(); const since = Number(req.query.since ?? 0); res.json({ items: await BrokerObligation.find({ traderId: req.auth!.traderId, seq: { $gt: since } }).sort({ seq: 1 }).lean() }); }));
traderRouter.get('/enlistments', traderAuthenticate, asyncHandler(async (req, res) => res.json({ items: await Enlistment.find({ traderId: req.auth!.traderId }).sort({ createdAt: -1 }).lean() })));
traderRouter.post('/enlistments', traderAuthenticate, asyncHandler(async (req, res) => { const body = parse(z.object({ symbol: z.string().min(1), depositoryId: z.string().min(1), lots: z.array(z.object({ lotId: z.string().min(1), weight: z.number().positive() })).min(1), note: z.string().default('') }), req.body); const security = await SecurityReplica.findOne({ symbol: body.symbol.toUpperCase(), depositoryId: body.depositoryId }); if (!security) throw new ApiError(409, 'Security/depository combination is not available'); const item = await Enlistment.create({ enlistmentId: await nextId('enlistment'), accountId: req.auth!.accountId, traderId: req.auth!.traderId, securityId: security.securityId, ...body, symbol: body.symbol.toUpperCase() }); res.status(201).json(item); }));
