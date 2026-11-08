import { ApiError } from '../../common/errors.js';
import { FacilityUser } from './org.models.js';

export type ColdRole = 'OrgAdmin' | 'FacilityManager' | 'InventoryOperator' | 'AccountsOperator' | 'GateOperator' | 'Auditor';

/**
 * Resolves the calling user's cold-storage access.
 * - A Cold-realm admin (central administrator) holds cross-facility rights without
 *   needing a FacilityUser row: they can list and operate across every organization/facility.
 * - Facility users resolve to their strongest assigned role within the requested facility.
 */
export async function resolveColdAccess(input: {
  userId: string;
  facilityId?: string;
  isCentralAdmin?: boolean;
}): Promise<{ organizationIds: string[]; facilityId: string | null; role: ColdRole; isCentralAdmin: boolean }> {
  const query: Record<string, unknown> = { userId: input.userId, status: 'Active' };
  if (input.facilityId) query.facilityId = input.facilityId;
  const assignments = await FacilityUser.find(query).lean();

  // Central administrator of the cold network: cross-facility, role OrgAdmin.
  if (input.isCentralAdmin) {
    return { organizationIds: [], facilityId: input.facilityId ?? null, role: 'OrgAdmin', isCentralAdmin: true };
  }

  if (assignments.length === 0) {
    throw new ApiError(403, 'This identity has no cold-storage facility access', 'COLD_FORBIDDEN');
  }

  const priority = ['OrgAdmin', 'FacilityManager', 'AccountsOperator', 'InventoryOperator', 'GateOperator', 'Auditor'] as const;
  const role = assignments
    .map((a) => a.role)
    .sort((a, b) => priority.indexOf(a) - priority.indexOf(b))[0] as ColdRole;

  const facilityIds = [...new Set(assignments.filter((a) => a.facilityId).map((a) => a.facilityId))];
  const organizationIds = [...new Set(assignments.map((a) => a.organizationId))];

  // Multi-facility/org users (incl. org admins) act across their facilities:
  // they pick a "current facility" per request via header; default = first facility.
  const facilityId = input.facilityId ?? facilityIds[0] ?? null;
  return { organizationIds, facilityId, role, isCentralAdmin: false };
}

export function requireColdRole(role: string, allowed: string[]): void {
  if (!allowed.includes(role)) {
    throw new ApiError(403, 'You do not have permission to perform this action', 'COLD_FORBIDDEN');
  }
}

export function canRead(role: string): boolean {
  return ['OrgAdmin', 'FacilityManager', 'InventoryOperator', 'AccountsOperator', 'GateOperator', 'Auditor'].includes(role);
}

export function isWriteRole(role: string): boolean {
  return ['OrgAdmin', 'FacilityManager', 'InventoryOperator', 'AccountsOperator', 'GateOperator'].includes(role);
}

export function isInventoryRole(role: string): boolean {
  return ['OrgAdmin', 'FacilityManager', 'InventoryOperator'].includes(role);
}

export function isAccountsRole(role: string): boolean {
  return ['OrgAdmin', 'FacilityManager', 'AccountsOperator'].includes(role);
}

export function isFacilityManagementRole(role: string): boolean {
  return ['OrgAdmin', 'FacilityManager'].includes(role);
}
