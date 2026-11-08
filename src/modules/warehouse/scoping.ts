import { ApiError } from '../../common/errors.js';
import { Facility, Organization } from './org.models.js';

/** Builds a Mongo filter constrained to an organization. */
export function scopeFilter(organizationId: string): { organizationId: string } {
  return { organizationId };
}

/** Ensures a facility exists and belongs to the organization. */
export async function requireFacilityInOrg(organizationId: string, facilityId: string): Promise<void> {
  const facility = await Facility.findOne({ facilityId, organizationId }).lean();
  if (!facility) throw new ApiError(404, 'Facility was not found in this organization');
}

/** Ensures the caller's organization scope allows access to the requested org. */
export async function requireOrganizationAccess(allowedOrganizationIds: string[], requestedOrganizationId: string): Promise<void> {
  if (!allowedOrganizationIds.includes(requestedOrganizationId)) {
    throw new ApiError(403, 'This identity cannot access the requested organization', 'COLD_FORBIDDEN');
  }
}

export async function assertOrganizationExists(organizationId: string): Promise<void> {
  const organization = await Organization.findOne({ organizationId }).lean();
  if (!organization) throw new ApiError(404, 'Organization was not found');
}

export async function requireFacilityAccess(ctx: { organizationIds: string[]; facilityId: string | null }, facilityId: string): Promise<void> {
  if (!facilityId) throw new ApiError(400, 'A facility is required for this operation');
  const facility = await Facility.findOne({ facilityId }).lean();
  if (!facility) throw new ApiError(404, 'Facility was not found');
  if (!ctx.organizationIds.includes(facility.organizationId)) throw new ApiError(403, 'This identity cannot access the requested facility', 'COLD_FORBIDDEN');
}

export async function requireOrganizationScope(ctx: { organizationIds: string[] }, organizationId: string): Promise<void> {
  await requireOrganizationAccess(ctx.organizationIds, organizationId);
}

/**
 * Resolves the organization id applicable to the current request.
 * Facility users use their assigned org; central admins resolve the org of the
 * facility selected via X-Facility-Id (fallback: any single-org facility).
 */
export async function resolveOrganizationId(input: { organizationIds: string[]; facilityId: string | null; isCentralAdmin: boolean }): Promise<string> {
  if (input.organizationIds.length > 0) return input.organizationIds[0]!;
  if (input.facilityId) {
    const facility = await Facility.findOne({ facilityId: input.facilityId }).lean();
    if (!facility) throw new ApiError(404, 'Facility was not found');
    return String(facility.organizationId);
  }
  if (input.isCentralAdmin) {
    const facility = await Facility.findOne({}).lean();
    if (facility) return String(facility.organizationId);
  }
  throw new ApiError(403, 'No organization context is available for this identity', 'COLD_FORBIDDEN');
}
