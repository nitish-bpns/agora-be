import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { ApiError } from '../../common/errors.js';
import { loginTrader } from '../broker/broker-auth.service.js';
import { realmForUserType, User, type UserRole, type UserType } from './auth.model.js';

export interface AccessClaims {
  sub: string;
  kind: 'operator' | 'trader';
  realm: 'Desk' | 'Broker' | 'Exchange' | 'Storage';
  role: UserRole;
  accountId?: string;
  traderId?: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function loginOperator(realm: AccessClaims['realm'], username: string, password: string): Promise<{ token: string; user: object }> {
  if (realm === 'Desk') throw new ApiError(403, 'Standalone desk operator login is not supported', 'UNSUPPORTED_USER_TYPE');
  const user = await User.findOne({ userType: realm, username: username.trim().toLowerCase() }).select('+passwordHash');
  if (!user || user.status !== 'Active' || !(await bcrypt.compare(password, user.passwordHash))) throw new ApiError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');
  const claims: AccessClaims = { sub: user.userId, kind: 'operator', realm, role: user.role };
  const token = signAccessToken(claims);
  return { token, user: { userId: user.userId, username: user.username, displayName: user.displayName, realm, role: user.role, passwordChanged: user.passwordChanged } };
}

export async function loginByUsername(username: string, password: string): Promise<{
  token: string;
  kind: 'operator' | 'trader';
  userType: UserType;
  realm: AccessClaims['realm'];
  role: UserRole;
  user: { userId: string; username: string; displayName: string; accountId?: string };
}> {
  const normalized = username.trim().toLowerCase();
  const user = await User.findOne({ username: normalized }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new ApiError(401, 'Incorrect username or password', 'INVALID_CREDENTIALS');

  if (user.userType === 'Trader') {
    const result = await loginTrader(normalized, password);
    return {
      token: result.token,
      kind: 'trader',
      userType: 'Trader',
      realm: 'Desk',
      role: 'Trader',
      user: { userId: user.userId, username: user.username, displayName: user.displayName, ...(user.accountId ? { accountId: user.accountId } : {}) }
    };
  }

  if (user.status !== 'Active') throw new ApiError(403, user.statusReason || 'This user is inactive', 'USER_INACTIVE');
  const realm = realmForUserType(user.userType);
  const claims: AccessClaims = { sub: user.userId, kind: 'operator', realm, role: user.role };
  return {
    token: signAccessToken(claims),
    kind: 'operator',
    userType: user.userType,
    realm,
    role: user.role,
    user: { userId: user.userId, username: user.username, displayName: user.displayName }
  };
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_EXPIRES_IN as NonNullable<jwt.SignOptions['expiresIn']> });
}

export function verifyAccessToken(token: string): AccessClaims {
  try { return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims; }
  catch { throw new ApiError(401, 'Authentication is required', 'UNAUTHORIZED'); }
}
