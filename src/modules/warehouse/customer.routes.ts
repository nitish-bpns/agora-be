import { Router } from 'express';
import { ApiError } from '../../common/errors.js';
import { asyncHandler } from '../../common/http.js';
import { authenticate } from '../auth/auth.middleware.js';
import { customerStock, customerEnvironment, customerLoadingEvents, customerFinance, customerCameras } from './customer.service.js';

/**
 * Customer / depositor terminal.
 * Authenticated by the standard JWT; the partyId claim links the user to their Party.
 */
export const customerRouter = Router();
customerRouter.use(authenticate);

function requirePartyId(req: { auth?: { partyId?: string } }): string {
  if (!req.auth?.partyId) throw new ApiError(403, 'This customer identity has no linked party', 'NO_PARTY_LINK');
  return req.auth.partyId;
}

customerRouter.get('/stock', asyncHandler(async (req, res) => {
  res.json(await customerStock(requirePartyId(req)));
}));

customerRouter.get('/environment', asyncHandler(async (req, res) => {
  res.json(await customerEnvironment(requirePartyId(req)));
}));

customerRouter.get('/loading', asyncHandler(async (req, res) => {
  res.json(await customerLoadingEvents(requirePartyId(req)));
}));

customerRouter.get('/finance', asyncHandler(async (req, res) => {
  res.json(await customerFinance(requirePartyId(req)));
}));

customerRouter.get('/cameras', asyncHandler(async (req, res) => {
  res.json(await customerCameras(requirePartyId(req)));
}));