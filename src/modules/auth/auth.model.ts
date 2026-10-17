import { Schema, model } from 'mongoose';

export const USER_TYPES = ['Trader', 'Broker', 'Exchange', 'Storage'] as const;
export const USER_ROLES = ['Trader', 'Admin', 'Operations', 'Read-only'] as const;
export const USER_STATUSES = ['Active', 'Suspended', 'Closed', 'Inactive'] as const;
export type UserType = (typeof USER_TYPES)[number];
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];

const userSchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
  displayName: { type: String, required: true, trim: true },
  email: { type: String, default: '', trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  userType: { type: String, enum: USER_TYPES, required: true, index: true },
  role: { type: String, enum: USER_ROLES, required: true },
  status: { type: String, enum: USER_STATUSES, required: true, default: 'Active', index: true },
  statusReason: { type: String, default: '' },
  accountId: { type: String, sparse: true, unique: true, index: true },
  passwordChanged: { type: Boolean, default: false }
}, { timestamps: true, versionKey: false });
userSchema.index({ userType: 1, status: 1 });
export const User = model('User', userSchema);

const userSessionSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  endedAt: Date
}, { versionKey: false });
userSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const UserSession = model('UserSession', userSessionSchema);

export function realmForUserType(userType: UserType): 'Desk' | 'Broker' | 'Exchange' | 'Storage' {
  return userType === 'Trader' ? 'Desk' : userType;
}
