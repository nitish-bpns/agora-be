import type { RequestHandler } from 'express';
import { ApiError } from '../../common/errors.js';
import { verifyAccessToken } from '../auth/auth.service.js';
import { FacilityUser, Facility } from '../warehouse/org.models.js';
import { resolveColdAccess } from '../warehouse/context.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      cold?: {
        userId: string;
        organizationIds: string[];
        organizationId: string | null;
        facilityId: string | null;
        role: 'OrgAdmin' | 'FacilityManager' | 'InventoryOperator' | 'AccountsOperator' | 'GateOperator' | 'Auditor';
        isCentralAdmin: boolean;
      };
      facilityHeader?: string;
    }
  }
}

/**
 * Cold-storage authentication middleware.
 * Verifies the bearer JWT itself (works like `authenticate` + cold access),
 * then resolves facility context from header `X-Facility-Id`.
 * A Cold-realm Admin is treated as a central administrator (cross-facility).
 */
export const coldAuth: RequestHandler = async (req, _res, next) => {
  try {
    const bearer = req.header('authorization');
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : req.header('x-session-token');
    if (!token) return next(new ApiError(401, 'Authentication is required', 'UNAUTHORIZED'));
    const claims = verifyAccessToken(token);
    req.auth = { subject: claims.sub, kind: claims.kind, realm: claims.realm, role: claims.role };
    const isCentralAdmin = claims.realm === 'Cold' && claims.role === 'Admin';
    const facilityHeader = typeof req.header('x-facility-id') === 'string' ? req.header('x-facility-id') : undefined;
    const access = await resolveColdAccess({ userId: claims.sub, facilityId: facilityHeader, isCentralAdmin });
    // For central admins operating inside a facility, resolve that facility's org so
    // existing routes that read organizationIds[0] keep working unchanged.
    let organizationIds = access.organizationIds;
    if (isCentralAdmin && facilityHeader && organizationIds.length === 0) {
      const facility = await Facility.findOne({ facilityId: facilityHeader }).lean();
      if (facility) organizationIds = [String(facility.organizationId)];
    }
    req.cold = { ...access, userId: claims.sub, organizationIds, organizationId: organizationIds[0] ?? null };
    req.facilityHeader = facilityHeader;
    next();
  } catch (error) {
    next(error);
  }
};

export const coldFacilityRequired: RequestHandler = (req, _res, next) => {
  if (!req.cold?.facilityId) return next(new ApiError(400, 'This operation requires a facility context (set X-Facility-Id)', 'FACILITY_REQUIRED'));
  next();
};

export const coldRoleGuard = (...roles: string[]): RequestHandler => (req, _res, next) => {
  if (!req.cold) return next(new ApiError(401, 'Authentication is required', 'UNAUTHORIZED'));
  if (!roles.includes(req.cold.role)) return next(new ApiError(403, 'You do not have permission to perform this action', 'COLD_FORBIDDEN'));
  next();
};

export async function getFacilityAssignments(userId: string): Promise<Array<{ facilityId: string; organizationId: string; role: string }>> {
  return FacilityUser.find({ userId, status: 'Active' }).select('facilityId organizationId role').lean();
}
