import type { RequestHandler } from 'express';
import { ApiError } from '../../common/errors.js';
import { resolveTraderSession } from './broker-auth.service.js';

export const traderAuthenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = req.header('x-session-token') ?? (req.header('authorization')?.startsWith('Bearer ') ? req.header('authorization')!.slice(7) : '');
    if (!token) throw new ApiError(401, 'Authentication is required', 'UNAUTHORIZED');
    const trader = await resolveTraderSession(token);
    req.auth = { subject: trader.traderId, kind: 'trader', realm: 'Broker', role: 'Trader', accountId: trader.accountId, traderId: trader.traderId };
    next();
  } catch (error) { next(error); }
};

export const canTrade: RequestHandler = async (req, _res, next) => {
  try {
    const trader = await resolveTraderSession(req.header('x-session-token') ?? req.header('authorization')?.slice(7) ?? '');
    if (trader.status !== 'Active') throw new ApiError(403, trader.statusReason || 'This account cannot trade', 'TRADING_REFUSED');
    next();
  } catch (error) { next(error); }
};
