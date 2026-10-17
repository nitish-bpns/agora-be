import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../../common/errors.js';
import { asyncHandler, parse } from '../../common/http.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Trader } from '../broker/broker.models.js';
import { authenticate, authorize } from './auth.middleware.js';
import { Operator } from './auth.model.js';
import { hashPassword, loginByUsername, loginOperator } from './auth.service.js';

export const authRouter = Router();
const realms = z.enum(['Desk', 'Broker', 'Exchange', 'Storage']);
const roles = z.enum(['Admin', 'Operations', 'Read-only']);

authRouter.post('/login', asyncHandler(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1), password: z.string().min(1) }), req.body);
  res.json(await loginByUsername(body.username, body.password));
}));
authRouter.post('/operator/login', asyncHandler(async (req, res) => {
  const body = parse(z.object({ realm: realms, username: z.string().min(1), password: z.string().min(1) }), req.body);
  res.json(await loginOperator(body.realm, body.username, body.password));
}));
authRouter.get('/me', authenticate, asyncHandler(async (req, res) => res.json({ auth: req.auth })));

authRouter.get('/operators', authenticate, authorize('Admin'), asyncHandler(async (req, res) => {
  res.json({ items: await Operator.find({ realm: req.auth!.realm }).select('-passwordHash').sort({ username: 1 }).lean() });
}));
authRouter.post('/operators', authenticate, authorize('Admin'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ username: z.string().min(3), displayName: z.string().min(1), password: z.string().min(8), role: roles }), req.body);
  if (await Trader.exists({ username: body.username.toLowerCase() })) throw new ApiError(409, 'Username is already assigned to a trader', 'DUPLICATE_USERNAME');
  const userId = await nextId('user');
  const user = await Operator.create({ userId, ...body, username: body.username.toLowerCase(), realm: req.auth!.realm, passwordHash: await hashPassword(body.password) });
  await recordAudit({ realm: req.auth!.realm, collection: 'operators', recordId: userId, action: 'Create', actorId: req.auth!.subject, after: user.toObject() });
  res.status(201).json({ userId: user.userId, username: user.username, displayName: user.displayName, role: user.role, isActive: user.isActive });
}));
authRouter.patch('/operators/:userId', authenticate, authorize('Admin'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ displayName: z.string().min(1).optional(), role: roles.optional(), isActive: z.boolean().optional(), password: z.string().min(8).optional() }), req.body);
  const user = await Operator.findOne({ userId: req.params.userId, realm: req.auth!.realm }).select('+passwordHash');
  if (!user) throw new ApiError(404, 'Operator not found');
  if (user.role === 'Admin' && (body.role && body.role !== 'Admin' || body.isActive === false)) {
    const activeAdmins = await Operator.countDocuments({ realm: user.realm, role: 'Admin', isActive: true });
    if (activeAdmins <= 1) throw new ApiError(409, 'The last active administrator cannot be deactivated or demoted', 'LAST_ADMIN');
  }
  const before = user.toObject();
  if (body.displayName) user.displayName = body.displayName;
  if (body.role) user.role = body.role;
  if (body.isActive !== undefined) user.isActive = body.isActive;
  if (body.password) { user.passwordHash = await hashPassword(body.password); user.passwordChanged = true; }
  await user.save();
  await recordAudit({ realm: req.auth!.realm, collection: 'operators', recordId: user.userId, action: 'Update', actorId: req.auth!.subject, before, after: user.toObject() });
  res.json({ userId: user.userId, role: user.role, isActive: user.isActive });
}));
