import crypto from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { businessDaysBetween, isoDate } from '../../common/dates.js';
import { asyncHandler, pagination, parse } from '../../common/http.js';
import { nextId } from '../../common/ids.js';
import { inTransaction } from '../../common/transaction.js';
import { recordAudit } from '../audit/audit.service.js';
import { authenticate, authorize, requireRealm } from '../auth/auth.middleware.js';
import { CustodyLot } from '../storage/storage.models.js';
import { cancelExchangeOrder, submitOrder } from './matching.service.js';
import { BrokerMember, Depository, ExchangeLot, ExchangeOrder, Execution, Instrument, Mandi, Obligation, Security, SettlementInstruction } from './exchange.models.js';
import { failExecution, settleExecution } from './settlement.service.js';

export const exchangeRouter = Router();
exchangeRouter.use(authenticate, requireRealm('Exchange'), authorize('Admin', 'Operations', 'Read-only'));
const write = authorize('Admin', 'Operations');

exchangeRouter.get('/dashboard', asyncHandler(async (_req, res) => {
  const [mandis, securities, brokers, depositories, openOrders, executions, openObligations, overdue] = await Promise.all([
    Mandi.countDocuments({ status: 'Active' }), Security.countDocuments({ status: 'Listed' }), BrokerMember.countDocuments({ status: 'Active' }), Depository.countDocuments({ status: 'Active' }),
    ExchangeOrder.countDocuments({ status: { $in: ['Open', 'Partially Executed'] } }), Execution.countDocuments(), Obligation.countDocuments({ status: 'Unsettled' }),
    Obligation.find({ status: 'Unsettled', settlementDate: { $lt: isoDate() } }).lean()
  ]);
  res.json({ mandis, securities, brokers, depositories, openOrders, executions, openObligations, overdue: overdue.length, overdueValue: overdue.reduce((sum, item) => sum + item.consideration, 0) });
}));

exchangeRouter.get('/mandis', asyncHandler(async (_req, res) => res.json({ items: await Mandi.find().sort({ code: 1 }).lean() })));
exchangeRouter.post('/mandis', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ code: z.string().min(2), name: z.string().min(1), region: z.string().default(''), currency: z.string().length(3), timezone: z.string().default('UTC') }), req.body);
  const mandi = await Mandi.create({ mandiId: await nextId('mandi'), ...body });
  await recordAudit({ realm: 'Exchange', collection: 'mandis', recordId: mandi.mandiId, action: 'Create', actorId: req.auth!.subject, after: mandi.toObject() });
  res.status(201).json(mandi);
}));
exchangeRouter.patch('/mandis/:mandiId/status', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['Active', 'Halted', 'Closed']), reason: z.string().default('') }), req.body); const mandi = await Mandi.findOne({ mandiId: req.params.mandiId });
  if (!mandi) throw new ApiError(404, 'Mandi not found'); if (mandi.status === 'Closed') throw new ApiError(409, 'A closed mandi cannot be reopened');
  const before = mandi.toObject(); mandi.status = body.status; mandi.statusReason = body.reason; await mandi.save();
  await recordAudit({ realm: 'Exchange', collection: 'mandis', recordId: mandi.mandiId, action: 'Status', actorId: req.auth!.subject, before, after: mandi.toObject() }); res.json(mandi);
}));

exchangeRouter.get('/instruments', asyncHandler(async (_req, res) => res.json({ items: await Instrument.find().sort({ name: 1 }).lean() })));
exchangeRouter.post('/instruments', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ name: z.string().min(1), isin: z.string().default(''), assetType: z.string().min(1), sector: z.string().default(''), currency: z.string().length(3), issuer: z.string().default(''), issueDate: z.coerce.date().optional(), faceValue: z.number().nonnegative().default(0) }), req.body);
  const item = await Instrument.create({ instrumentId: await nextId('instrument'), ...body }); await recordAudit({ realm: 'Exchange', collection: 'instruments', recordId: item.instrumentId, action: 'Create', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json(item);
}));

exchangeRouter.get('/securities', asyncHandler(async (req, res) => { const filter: Record<string, unknown> = {}; if (req.query.mandiId) filter.mandiId = req.query.mandiId; if (req.query.status) filter.status = req.query.status; res.json({ items: await Security.find(filter).sort({ symbol: 1 }).lean() }); }));
exchangeRouter.post('/securities', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ instrumentId: z.string().min(1), symbol: z.string().min(1), mandiId: z.string().min(1), tickSize: z.number().positive(), lotSize: z.number().positive(), priceBandPct: z.number().nonnegative(), referencePrice: z.number().positive(), settlementDays: z.number().int().nonnegative(), forwardPremium: z.number().default(0), lotWeight: z.number().nonnegative().default(0), depositoryId: z.string().min(1) }), req.body);
  const [instrument, mandi, depository] = await Promise.all([Instrument.findOne({ instrumentId: body.instrumentId }), Mandi.findOne({ mandiId: body.mandiId }), Depository.findOne({ depositoryId: body.depositoryId, mandiId: body.mandiId, status: 'Active' })]);
  if (!instrument || !mandi || !depository) throw new ApiError(409, 'A valid instrument, mandi, and active same-mandi depository are required');
  const item = await Security.create({ securityId: await nextId('security'), ...body }); await recordAudit({ realm: 'Exchange', collection: 'securities', recordId: item.securityId, action: 'List', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json(item);
}));
exchangeRouter.patch('/securities/:securityId/status', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['Listed', 'Suspended', 'Delisted']), reason: z.string().default('') }), req.body); const item = await Security.findOne({ securityId: req.params.securityId }); if (!item) throw new ApiError(404, 'Security not found'); if (item.status === 'Delisted') throw new ApiError(409, 'A delisted security cannot be relisted');
  const before = item.toObject(); item.status = body.status; item.statusReason = body.reason; await item.save(); await recordAudit({ realm: 'Exchange', collection: 'securities', recordId: item.securityId, action: 'Status', actorId: req.auth!.subject, before, after: item.toObject() }); res.json(item);
}));

exchangeRouter.get('/depositories', asyncHandler(async (_req, res) => res.json({ items: await Depository.find().sort({ code: 1 }).lean() })));
exchangeRouter.post('/depositories', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ code: z.string().min(2), name: z.string().min(1), mandiId: z.string().min(1), contactEmail: z.string().email().or(z.literal('')).default(''), assetClasses: z.array(z.string()).default([]) }), req.body); if (!await Mandi.exists({ mandiId: body.mandiId })) throw new ApiError(404, 'Mandi not found');
  const item = await Depository.create({ depositoryId: await nextId('depository'), ...body }); await recordAudit({ realm: 'Exchange', collection: 'depositories', recordId: item.depositoryId, action: 'Create', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json(item);
}));
exchangeRouter.patch('/depositories/:depositoryId/status', write, asyncHandler(async (req, res) => { const body = parse(z.object({ status: z.enum(['Active', 'Inactive']) }), req.body); const item = await Depository.findOneAndUpdate({ depositoryId: req.params.depositoryId }, { status: body.status }, { new: true }); if (!item) throw new ApiError(404, 'Depository not found'); res.json(item); }));

exchangeRouter.get('/brokers', asyncHandler(async (_req, res) => res.json({ items: await BrokerMember.find().sort({ code: 1 }).lean() })));
exchangeRouter.post('/brokers', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ code: z.string().min(2), name: z.string().min(1), mandiId: z.string().min(1), contactEmail: z.string().email().or(z.literal('')).default('') }), req.body); if (!await Mandi.exists({ mandiId: body.mandiId })) throw new ApiError(404, 'Mandi not found');
  const apiKey = `bkr_${crypto.randomBytes(32).toString('base64url')}`; const item = await BrokerMember.create({ brokerId: await nextId('broker'), ...body, apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex'), apiKeyPrefix: apiKey.slice(0, 12) });
  await recordAudit({ realm: 'Exchange', collection: 'brokers', recordId: item.brokerId, action: 'Register', actorId: req.auth!.subject, after: item.toObject() }); res.status(201).json({ broker: item, apiKey });
}));
exchangeRouter.patch('/brokers/:brokerId/status', write, asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['Active', 'Suspended', 'Terminated']), reason: z.string().default('') }), req.body); const item = await BrokerMember.findOne({ brokerId: req.params.brokerId }); if (!item) throw new ApiError(404, 'Broker not found'); if (item.status === 'Terminated') throw new ApiError(409, 'A terminated membership cannot be restored'); item.status = body.status; item.statusReason = body.reason; await item.save(); res.json(item);
}));
exchangeRouter.post('/brokers/:brokerId/rotate-key', authorize('Admin'), asyncHandler(async (req, res) => { const item = await BrokerMember.findOne({ brokerId: req.params.brokerId }).select('+apiKeyHash'); if (!item) throw new ApiError(404, 'Broker not found'); const apiKey = `bkr_${crypto.randomBytes(32).toString('base64url')}`; item.apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex'); item.apiKeyPrefix = apiKey.slice(0, 12); await item.save(); res.json({ apiKey, apiKeyPrefix: item.apiKeyPrefix }); }));

exchangeRouter.get('/orders', asyncHandler(async (req, res) => { const { page, limit, skip } = pagination(req.query); const filter: Record<string, unknown> = {}; for (const key of ['brokerId', 'symbol', 'status', 'mandiId'] as const) if (req.query[key]) filter[key] = req.query[key]; const [items, total] = await Promise.all([ExchangeOrder.find(filter).sort({ seq: -1 }).skip(skip).limit(limit).lean(), ExchangeOrder.countDocuments(filter)]); res.json({ items, total, page, limit }); }));
exchangeRouter.get('/executions', asyncHandler(async (req, res) => { const filter = req.query.brokerId ? { $or: [{ buyBrokerId: req.query.brokerId }, { sellBrokerId: req.query.brokerId }] } : {}; res.json({ items: await Execution.find(filter).sort({ seq: -1 }).limit(500).lean() }); }));
exchangeRouter.get('/book/:symbol', asyncHandler(async (req, res) => { const symbol = String(req.params.symbol ?? '').toUpperCase(); const open = { symbol, status: { $in: ['Open', 'Partially Executed'] } }; const [bids, asks] = await Promise.all([ExchangeOrder.find({ ...open, action: 'Buy' }).sort({ price: -1, seq: 1 }).lean(), ExchangeOrder.find({ ...open, action: 'Sell' }).sort({ price: 1, seq: 1 }).lean()]); res.json({ symbol, bids, asks }); }));
exchangeRouter.get('/obligations', asyncHandler(async (req, res) => { const filter: Record<string, unknown> = {}; for (const key of ['brokerId', 'status', 'side', 'symbol'] as const) if (req.query[key]) filter[key] = req.query[key]; const items = await Obligation.find(filter).sort({ settlementDate: 1, seq: 1 }).lean(); const today = isoDate(); res.json({ items: items.map((item) => ({ ...item, isOverdue: item.status === 'Unsettled' && item.settlementDate < today, daysLate: item.settlementDate < today ? businessDaysBetween(item.settlementDate, today) : 0 })) }); }));
exchangeRouter.post('/obligations/:obligationId/settle', write, asyncHandler(async (req, res) => res.json({ items: await settleExecution(String(req.params.obligationId ?? ''), req.auth!.subject) })));
exchangeRouter.post('/obligations/:obligationId/fail', write, asyncHandler(async (req, res) => { const body = parse(z.object({ reason: z.string().min(1) }), req.body); res.json({ items: await failExecution(String(req.params.obligationId ?? ''), body.reason, req.auth!.subject) }); }));
exchangeRouter.get('/instructions', asyncHandler(async (_req, res) => res.json({ items: await SettlementInstruction.find().sort({ issuedAt: -1 }).lean() })));

const memberAuth: RequestHandler = asyncHandler(async (req, res, next) => {
  const key = req.header('x-api-key'); if (!key) throw new ApiError(401, 'Exchange API key is required');
  const keyHash = crypto.createHash('sha256').update(key).digest('hex'); const member = await BrokerMember.findOne({ apiKeyHash: keyHash }).select('+apiKeyHash');
  if (!member) throw new ApiError(401, 'Unknown exchange API key'); if (member.status !== 'Active') throw new ApiError(403, member.statusReason || 'Member is not active', 'MEMBER_REFUSED'); res.locals.member = member; next();
});
export const exchangeMemberRouter = Router();
exchangeMemberRouter.use(memberAuth);
exchangeMemberRouter.get('/brokers/self', asyncHandler(async (_req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; res.json({ brokerId: member.brokerId, code: member.code, name: member.name, mandiId: member.mandiId, status: member.status }); }));
exchangeMemberRouter.get('/securities', asyncHandler(async (_req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; res.json({ items: await Security.find({ mandiId: member.mandiId, status: 'Listed' }).sort({ symbol: 1 }).lean() }); }));
exchangeMemberRouter.get('/book', asyncHandler(async (req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; const symbol = String(req.query.symbol ?? '').toUpperCase(); const open = { mandiId: member.mandiId, symbol, status: { $in: ['Open', 'Partially Executed'] } }; res.json({ symbol, bids: await ExchangeOrder.find({ ...open, action: 'Buy' }).sort({ price: -1, seq: 1 }).lean(), asks: await ExchangeOrder.find({ ...open, action: 'Sell' }).sort({ price: 1, seq: 1 }).lean() }); }));
exchangeMemberRouter.post('/orders', asyncHandler(async (req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; res.json(await submitOrder(member.brokerId, req.body)); }));
exchangeMemberRouter.get('/orders', asyncHandler(async (_req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; res.json({ items: await ExchangeOrder.find({ brokerId: member.brokerId }).sort({ seq: -1 }).lean() }); }));
exchangeMemberRouter.get('/order', asyncHandler(async (req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; const item = await ExchangeOrder.findOne({ brokerId: member.brokerId, orderId: req.query.order_id }); if (!item) throw new ApiError(404, 'Order not found'); res.json(item); }));
exchangeMemberRouter.post('/orders/cancel', asyncHandler(async (req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; const body = parse(z.object({ orderId: z.string().min(1) }), req.body); res.json(await cancelExchangeOrder(member.brokerId, body.orderId)); }));
exchangeMemberRouter.get('/executions', asyncHandler(async (req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; const since = Number(req.query.since ?? 0); res.json({ items: await Execution.find({ seq: { $gt: since }, $or: [{ buyBrokerId: member.brokerId }, { sellBrokerId: member.brokerId }] }).sort({ seq: 1 }).lean() }); }));
exchangeMemberRouter.get('/obligations', asyncHandler(async (req, res) => { const member = res.locals.member as InstanceType<typeof BrokerMember>; const since = Number(req.query.since ?? 0); res.json({ items: await Obligation.find({ brokerId: member.brokerId, seq: { $gt: since } }).sort({ seq: 1 }).lean() }); }));
exchangeMemberRouter.post('/lots/enlist', asyncHandler(async (req, res) => {
  const member = res.locals.member as InstanceType<typeof BrokerMember>; const body = parse(z.object({ symbol: z.string().min(1), depositoryId: z.string().min(1), lots: z.array(z.object({ lotId: z.string().min(1), weight: z.number().positive() })).min(1) }), req.body);
  const security = await Security.findOne({ mandiId: member.mandiId, symbol: body.symbol.toUpperCase(), depositoryId: body.depositoryId, status: 'Listed' }); if (!security) throw new ApiError(409, 'Security is not listed with the specified depository');
  const result = await inTransaction(async (session) => { const registered = []; for (const requested of body.lots) { const custody = await CustodyLot.findOne({ lotId: requested.lotId, depositoryId: body.depositoryId, securityId: security.securityId, ownerId: member.brokerId, status: 'Held' }).session(session); if (!custody || Math.abs(custody.weight - requested.weight) > 1e-8) throw new ApiError(409, `Lot ${requested.lotId} is not valid custody inventory`); registered.push({ lotId: requested.lotId, securityId: security.securityId, symbol: security.symbol, depositoryId: body.depositoryId, ownerBrokerId: member.brokerId, weight: requested.weight }); } await ExchangeLot.insertMany(registered, { session }); return registered; });
  res.status(201).json({ items: result });
}));
