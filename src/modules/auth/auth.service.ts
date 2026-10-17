import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ApiError } from '../../common/errors.js';
import { loginTrader } from '../broker/broker-auth.service.js';
import { Operator } from './auth.model.js';

export interface AccessClaims {
  sub: string;
  kind: 'operator' | 'trader';
  realm: 'Desk' | 'Broker' | 'Exchange' | 'Storage';
  role: 'Admin' | 'Operations' | 'Read-only' | 'Trader';
  accountId?: string;
  traderId?: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function loginOperator(realm: AccessClaims['realm'], username: string, password: string): Promise<{ token: string; user: object }> {
  const user = await Operator.findOne({ realm, username: username.trim().toLowerCase() }).select('+passwordHash');
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) throw new ApiError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
  const claims: AccessClaims = { sub: user.userId, kind: 'operator', realm, role: user.role };
  const token = jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_EXPIRES_IN as NonNullable<jwt.SignOptions['expiresIn']> });
  return { token, user: { userId: user.userId, username: user.username, displayName: user.displayName, realm, role: user.role, passwordChanged: user.passwordChanged } };
}

export async function loginByUsername(username: string, password: string): Promise<{
  token: string;
  kind: 'operator' | 'trader';
  userType: 'Trader' | 'Broker' | 'Exchange' | 'Storage';
  realm: AccessClaims['realm'];
  role: AccessClaims['role'];
  user: { userId: string; username: string; displayName: string; accountId?: string };
}> {
  const normalized = username.trim().toLowerCase();
  const operator = await Operator.findOne({ username: normalized }).select('+passwordHash');
  if (operator) {
    if (!operator.isActive || !(await bcrypt.compare(password, operator.passwordHash))) {
      throw new ApiError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
    }
    if (operator.realm === 'Desk') {
      throw new ApiError(403, 'Standalone desk operator login is no longer supported', 'UNSUPPORTED_USER_TYPE');
    }
    const claims: AccessClaims = { sub: operator.userId, kind: 'operator', realm: operator.realm, role: operator.role };
    return {
      token: signAccessToken(claims),
      kind: 'operator',
      userType: operator.realm,
      realm: operator.realm,
      role: operator.role,
      user: { userId: operator.userId, username: operator.username, displayName: operator.displayName }
    };
  }

  try {
    const result = await loginTrader(normalized, password);
    return {
      token: result.token,
      kind: 'trader',
      userType: 'Trader',
      realm: 'Desk',
      role: 'Trader',
      user: { userId: result.trader.traderId, username: result.trader.username, displayName: result.trader.displayName, accountId: result.trader.accountId }
    };
  } catch (error) {
    if (error instanceof ApiError && ['ACCOUNT_CLOSED'].includes(error.code)) throw error;
    throw new ApiError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
  }
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_EXPIRES_IN as NonNullable<jwt.SignOptions['expiresIn']> });
}

export function verifyAccessToken(token: string): AccessClaims {
  try { return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims; }
  catch { throw new ApiError(401, 'Authentication is required', 'UNAUTHORIZED'); }
}
