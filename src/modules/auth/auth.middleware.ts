import type { RequestHandler } from 'express';
import { ApiError } from '../../common/errors.js';
import { verifyAccessToken } from './auth.service.js';

export const authenticate: RequestHandler = (req, _res, next) => {
  const bearer = req.header('authorization');
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : req.header('x-session-token');
  if (!token) return next(new ApiError(401, 'Authentication is required', 'UNAUTHORIZED'));
  const claims = verifyAccessToken(token);
  req.auth = { subject: claims.sub, kind: claims.kind, realm: claims.realm, role: claims.role, ...(claims.accountId ? { accountId: claims.accountId } : {}), ...(claims.traderId ? { traderId: claims.traderId } : {}) };
  next();
};

export function authorize(...roles: Array<'Admin' | 'Operations' | 'Read-only' | 'Trader'>): RequestHandler {
  return (req, _res, next) => req.auth && roles.includes(req.auth.role) ? next() : next(new ApiError(403, 'You do not have permission to perform this action', 'FORBIDDEN'));
}

export function requireRealm(...realms: Array<'Desk' | 'Broker' | 'Exchange' | 'Storage'>): RequestHandler {
  return (req, _res, next) => req.auth && realms.includes(req.auth.realm) ? next() : next(new ApiError(403, 'This identity cannot access the requested portal', 'WRONG_REALM'));
}
