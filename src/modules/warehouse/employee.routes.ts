import { Router } from 'express';
import { ApiError } from '../../common/errors.js';
import { asyncHandler } from '../../common/http.js';
import { authenticate } from '../auth/auth.middleware.js';
import { employeeEnvironment, employeeToday, employeeYesterday, employeeFleet } from './employee.service.js';

/**
 * Employee terminal.
 * Authenticated by the standard JWT; the facilityId claim scopes the employee to one facility.
 */
export const employeeRouter = Router();
employeeRouter.use(authenticate);

function requireFacilityId(req: { auth?: { facilityId?: string } }): string {
  if (!req.auth?.facilityId) throw new ApiError(403, 'This employee identity has no linked facility', 'NO_FACILITY_LINK');
  return req.auth.facilityId;
}

employeeRouter.get('/environment', asyncHandler(async (req, res) => {
  res.json(await employeeEnvironment(requireFacilityId(req)));
}));

employeeRouter.get('/today', asyncHandler(async (req, res) => {
  res.json(await employeeToday(requireFacilityId(req)));
}));

employeeRouter.get('/yesterday', asyncHandler(async (req, res) => {
  res.json(await employeeYesterday(requireFacilityId(req)));
}));

employeeRouter.get('/fleet', asyncHandler(async (req, res) => {
  res.json(await employeeFleet(requireFacilityId(req)));
}));