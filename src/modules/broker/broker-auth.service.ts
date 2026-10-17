import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ApiError } from '../../common/errors.js';
import { User, UserSession } from '../auth/auth.model.js';

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export interface TraderLoginResult {
  token: string;
  trader: { traderId: string; accountId: string; username: string; displayName: string; status: string; statusReason: string };
  canTrade: boolean;
  reason: string;
}

export async function loginTrader(username: string, password: string): Promise<TraderLoginResult> {
  const trader = await User.findOne({ username: username.trim().toLowerCase(), userType: 'Trader' }).select('+passwordHash');
  if (!trader || !(await bcrypt.compare(password, trader.passwordHash))) throw new ApiError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
  if (trader.status === 'Closed') throw new ApiError(403, trader.statusReason || 'This account is closed', 'ACCOUNT_CLOSED');
  if (!trader.accountId) throw new ApiError(409, 'Trader account is not configured', 'ACCOUNT_NOT_CONFIGURED');
  const token = crypto.randomBytes(32).toString('base64url');
  await UserSession.create({ tokenHash: hashToken(token), userId: trader.userId, expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000) });
  return { token, trader: { traderId: trader.userId, accountId: trader.accountId, username: trader.username, displayName: trader.displayName, status: trader.status, statusReason: trader.statusReason }, canTrade: trader.status === 'Active', reason: trader.status === 'Active' ? '' : trader.statusReason || 'Account is suspended' };
}

export async function resolveTraderSession(token: string): Promise<InstanceType<typeof User>> {
  const session = await UserSession.findOne({ tokenHash: hashToken(token), endedAt: { $exists: false }, expiresAt: { $gt: new Date() } });
  if (!session) throw new ApiError(401, 'Authentication is required', 'UNAUTHORIZED');
  const trader = await User.findOne({ userId: session.userId, userType: 'Trader' });
  if (!trader || trader.status === 'Closed') throw new ApiError(401, 'Authentication is required', 'UNAUTHORIZED');
  return trader;
}

export async function logoutTrader(token: string): Promise<void> {
  await UserSession.updateOne({ tokenHash: hashToken(token), endedAt: { $exists: false } }, { $set: { endedAt: new Date() } });
}

export async function endTraderSessions(traderId: string): Promise<void> {
  await UserSession.updateMany({ userId: traderId, endedAt: { $exists: false } }, { $set: { endedAt: new Date() } });
}
