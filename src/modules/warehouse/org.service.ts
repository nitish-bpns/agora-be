import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { hashPassword } from '../auth/auth.service.js';
import { User } from '../auth/auth.model.js';
import {
  Department, Driver, Employee, Facility, FacilityUser, Organization, Party, Vehicle
} from './org.models.js';
import { requireFacilityAccess, requireOrganizationScope, scopeFilter } from './scoping.js';

/* ------------------------------------------------------------------ */
/* Organizations                                                       */
/* ------------------------------------------------------------------ */

export async function createOrganization(input: { name: string; tin?: string; gstin?: string; address?: string; timezone?: string }, actorId: string): Promise<object> {
  const organizationId = await nextId('organization');
  const organization = await Organization.create({ organizationId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'organizations', recordId: organizationId, action: 'Create', actorId, after: organization.toObject() });
  return organization.toObject();
}

/* ------------------------------------------------------------------ */
/* Facilities                                                          */
/* ------------------------------------------------------------------ */

export async function createFacility(input: {
  organizationId: string; name: string; code: string; address?: string; timezone?: string;
  freezingCapacityKg?: number; coldStorageCapacityKg?: number; ambientCapacityKg?: number;
}, actorId: string): Promise<object> {
  const facilityId = await nextId('facility');
  const facility = await Facility.create({ facilityId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'facilities', recordId: facilityId, action: 'Create', actorId, after: facility.toObject() });
  return facility.toObject();
}

export async function listFacilities(organizationId: string): Promise<object[]> {
  return Facility.find({ organizationId }).sort({ name: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Facility users (RBAC)                                              */
/* ------------------------------------------------------------------ */

export async function assignFacilityUser(input: { organizationId: string; facilityId: string; userId: string; role: string }, actorId: string): Promise<object> {
  const facilityUserId = await nextId('facilityUser');
  const record = await FacilityUser.create({ facilityUserId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'facilityUsers', recordId: facilityUserId, action: 'Create', actorId, after: record.toObject() });
  return record.toObject();
}

export async function listFacilityUsers(facilityId: string): Promise<object[]> {
  return FacilityUser.find({ facilityId, status: 'Active' }).sort({ role: 1 }).lean();
}

/**
 * Creates a login account for a cold-storage facility user (the "storage owner" side).
 * Creates the auth User (realm Cold, role Operations) plus the FacilityUser assignment
 * that scopes them to one facility with a cold role (FacilityManager etc.).
 */
export async function createFacilityUserAccount(input: {
  organizationId: string; facilityId: string; username: string; displayName: string; password: string; role: string;
}, actorId: string): Promise<object> {
  const facility = await Facility.findOne({ facilityId: input.facilityId, organizationId: input.organizationId }).lean();
  if (!facility) throw new ApiError(404, `Facility ${input.facilityId} was not found in this organization`);
  const existing = await User.findOne({ username: input.username.trim().toLowerCase() }).lean();
  if (existing) throw new ApiError(409, 'A user with this username already exists', 'USERNAME_TAKEN');
  const userId = await nextId('user');
  const facilityUserId = await nextId('facilityUser');
  const user = await User.create({
    userId, username: input.username.trim().toLowerCase(), displayName: input.displayName,
    userType: 'Cold', role: 'Operations', status: 'Active', passwordChanged: true,
    passwordHash: await hashPassword(input.password)
  });
  const assignment = await FacilityUser.create({
    facilityUserId, organizationId: input.organizationId, facilityId: input.facilityId, userId, role: input.role, status: 'Active'
  });
  await recordAudit({ realm: 'Cold', collection: 'facilityUsers', recordId: facilityUserId, action: 'Create', actorId, after: assignment.toObject() });
  return { userId, facilityUserId, username: user.username, displayName: user.displayName, facilityId: input.facilityId, role: input.role };
}

/**
 * Creates a customer (depositor) login account linked to a Party.
 * The customer sees their lots across ALL facilities via the partyId claim.
 */
export async function createCustomerAccount(input: {
  organizationId: string; partyId: string; username: string; displayName: string; password: string;
}, actorId: string): Promise<object> {
  const party = await Party.findOne({ partyId: input.partyId, organizationId: input.organizationId }).lean();
  if (!party) throw new ApiError(404, `Party ${input.partyId} was not found in this organization`);
  const existing = await User.findOne({ username: input.username.trim().toLowerCase() }).lean();
  if (existing) throw new ApiError(409, 'A user with this username already exists', 'USERNAME_TAKEN');
  const userId = await nextId('user');
  const user = await User.create({
    userId, username: input.username.trim().toLowerCase(), displayName: input.displayName,
    userType: 'Customer', role: 'Read-only', status: 'Active', passwordChanged: true,
    partyId: input.partyId, passwordHash: await hashPassword(input.password)
  });
  await recordAudit({ realm: 'Cold', collection: 'users', recordId: userId, action: 'Create Customer Account', actorId, after: user.toObject() });
  return { userId, username: user.username, displayName: user.displayName, partyId: input.partyId };
}

/**
 * Creates an employee login account scoped to one facility.
 * The employee sees live temperature, today's/yesterday's loading and fleet.
 */
export async function createEmployeeAccount(input: {
  organizationId: string; facilityId: string; username: string; displayName: string; password: string;
}, actorId: string): Promise<object> {
  const facility = await Facility.findOne({ facilityId: input.facilityId, organizationId: input.organizationId }).lean();
  if (!facility) throw new ApiError(404, `Facility ${input.facilityId} was not found in this organization`);
  const existing = await User.findOne({ username: input.username.trim().toLowerCase() }).lean();
  if (existing) throw new ApiError(409, 'A user with this username already exists', 'USERNAME_TAKEN');
  const userId = await nextId('user');
  const user = await User.create({
    userId, username: input.username.trim().toLowerCase(), displayName: input.displayName,
    userType: 'Employee', role: 'Operations', status: 'Active', passwordChanged: true,
    facilityId: input.facilityId, passwordHash: await hashPassword(input.password)
  });
  await recordAudit({ realm: 'Cold', collection: 'users', recordId: userId, action: 'Create Employee Account', actorId, after: user.toObject() });
  return { userId, username: user.username, displayName: user.displayName, facilityId: input.facilityId };
}

/**
 * Creates a financer login account linked to a Financer record.
 * The financer sees pledge applications addressed to them and reacts.
 */
export async function createFinancerAccount(input: {
  financerId: string; username: string; displayName: string; password: string;
}, actorId: string): Promise<object> {
  const existing = await User.findOne({ username: input.username.trim().toLowerCase() }).lean();
  if (existing) throw new ApiError(409, 'A user with this username already exists', 'USERNAME_TAKEN');
  const userId = await nextId('user');
  const user = await User.create({
    userId, username: input.username.trim().toLowerCase(), displayName: input.displayName,
    userType: 'Financer', role: 'Operations', status: 'Active', passwordChanged: true,
    financerId: input.financerId, passwordHash: await hashPassword(input.password)
  });
  await recordAudit({ realm: 'Cold', collection: 'users', recordId: userId, action: 'Create Financer Account', actorId, after: user.toObject() });
  return { userId, username: user.username, displayName: user.displayName, financerId: input.financerId };
}

/* ------------------------------------------------------------------ */
/* Parties (customers/farmers/traders/suppliers)                       */
/* ------------------------------------------------------------------ */

export async function createParty(input: { organizationId: string; partyType: string; name: string; legalName?: string; contactPerson?: string; phone?: string; email?: string; gstin?: string; creditLimit?: number }, actorId: string): Promise<object> {
  const partyId = await nextId('party');
  const party = await Party.create({ partyId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'parties', recordId: partyId, action: 'Create', actorId, after: party.toObject() });
  return party.toObject();
}

export async function listParties(input: { organizationId: string; partyType?: string; search?: string }): Promise<object[]> {
  const filter: Record<string, unknown> = scopeFilter(input.organizationId);
  if (input.partyType) filter.partyType = input.partyType;
  if (input.search) {
    filter.$or = [
      { name: { $regex: input.search, $options: 'i' } },
      { partyId: { $regex: input.search, $options: 'i' } },
      { phone: { $regex: input.search, $options: 'i' } }
    ];
  }
  return Party.find(filter).sort({ name: 1 }).limit(200).lean();
}

/* ------------------------------------------------------------------ */
/* Employees                                                           */
/* ------------------------------------------------------------------ */

export async function createEmployee(input: { organizationId: string; facilityId: string; name: string; designation?: string; departmentId?: string; phone?: string; dateJoined?: string }, actorId: string): Promise<object> {
  const employeeId = await nextId('employee');
  const employee = await Employee.create({ employeeId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'employees', recordId: employeeId, action: 'Create', actorId, after: employee.toObject() });
  return employee.toObject();
}

export async function listEmployees(facilityId: string): Promise<object[]> {
  return Employee.find({ facilityId, status: 'Active' }).sort({ name: 1 }).lean();
}

export async function createDepartment(input: { organizationId: string; name: string }, actorId: string): Promise<object> {
  const departmentId = await nextId('department');
  const department = await Department.create({ departmentId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'departments', recordId: departmentId, action: 'Create', actorId, after: department.toObject() });
  return department.toObject();
}

export async function listDepartments(organizationId: string): Promise<object[]> {
  return Department.find({ organizationId }).sort({ name: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Vehicles & drivers                                                  */
/* ------------------------------------------------------------------ */

export async function createVehicle(input: {
  organizationId: string; facilityId: string; registrationNumber: string; makeModel?: string; capacityTonne?: number;
  trackerStatus?: string; trackerProvider?: string; trackerDeviceId?: string;
}, actorId: string): Promise<object> {
  const vehicleId = await nextId('vehicle');
  const vehicle = await Vehicle.create({ vehicleId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'vehicles', recordId: vehicleId, action: 'Create', actorId, after: vehicle.toObject() });
  return vehicle.toObject();
}

export async function listVehicles(facilityId: string): Promise<object[]> {
  return Vehicle.find({ facilityId }).sort({ registrationNumber: 1 }).lean();
}

export async function createDriver(input: { organizationId: string; name: string; phone?: string; licenseNumber?: string }, actorId: string): Promise<object> {
  const driverId = await nextId('driver');
  const driver = await Driver.create({ driverId, ...input });
  await recordAudit({ realm: 'Storage', collection: 'drivers', recordId: driverId, action: 'Create', actorId, after: driver.toObject() });
  return driver.toObject();
}

export async function listDrivers(organizationId: string): Promise<object[]> {
  return Driver.find({ organizationId, status: 'Active' }).sort({ name: 1 }).lean();
}

/* Re-exported guards used by routes */
export { requireFacilityAccess, requireOrganizationScope };
export async function assertFacilityInOrg(organizationId: string, facilityId: string): Promise<void> {
  const facility = await Facility.findOne({ facilityId, organizationId }).lean();
  if (!facility) throw new ApiError(404, `Facility ${facilityId} was not found`);
}
