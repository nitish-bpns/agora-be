import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/* ---------------------------------------------------------------- */
/* Organizations & facilities                                         */
/* ---------------------------------------------------------------- */

const organizationSchema = new Schema({
  organizationId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  tin: { type: String, default: '' },
  gstin: { type: String, default: '' },
  address: { type: String, default: '' },
  contactEmail: { type: String, default: '' },
  contactPhone: { type: String, default: '' },
  timezone: { type: String, default: 'Asia/Kolkata' },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
export const Organization = model('Organization', organizationSchema);

const facilitySchema = new Schema({
  facilityId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true },
  address: { type: String, default: '' },
  latitude: { type: Number, default: null },
  longitude: { type: Number, default: null },
  timezone: { type: String, default: 'Asia/Kolkata' },
  freezingCapacityKg: { type: Number, default: 0 },
  coldStorageCapacityKg: { type: Number, default: 0 },
  ambientCapacityKg: { type: Number, default: 0 },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
facilitySchema.index({ organizationId: 1, code: 1 }, { unique: true });
export const Facility = model('Facility', facilitySchema);

/* ---------------------------------------------------------------- */
/* Parties: customers, farmers, traders, suppliers                   */
/* ---------------------------------------------------------------- */

export const PARTY_TYPES = ['Customer', 'Farmer', 'Trader', 'Supplier', 'Other'] as const;

const partySchema = new Schema({
  partyId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  partyType: { type: String, enum: PARTY_TYPES, required: true, index: true },
  name: { type: String, required: true, trim: true },
  legalName: { type: String, default: '' },
  contactPerson: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },
  gstin: { type: String, default: '' },
  pan: { type: String, default: '' },
  creditLimit: { type: Number, default: 0 },
  status: { type: String, enum: ['Active', 'Inactive', 'Blacklisted'], default: 'Active' }
}, options);
partySchema.index({ organizationId: 1, partyType: 1, name: 1 });
export const Party = model('Party', partySchema);

/* ---------------------------------------------------------------- */
/* Employees & designations                                          */
/* ---------------------------------------------------------------- */

const departmentSchema = new Schema({
  departmentId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true }
}, options);
departmentSchema.index({ organizationId: 1, name: 1 }, { unique: true });
export const Department = model('Department', departmentSchema);

const employeeSchema = new Schema({
  employeeId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  designation: { type: String, default: '' },
  departmentId: { type: String, default: null },
  phone: { type: String, default: '' },
  userId: { type: String, default: null },
  dateJoined: { type: Date, default: null },
  status: { type: String, enum: ['Active', 'Inactive', 'Left'], default: 'Active' }
}, options);
export const Employee = model('Employee', employeeSchema);

/* ---------------------------------------------------------------- */
/* Vehicles & drivers                                                */
/* ---------------------------------------------------------------- */

export const TRACKER_STATUSES = ['TrackerConfigured', 'TrackerUnavailable', 'TemporarilyOffline', 'NotYetConfigured', 'Disabled'] as const;

const vehicleSchema = new Schema({
  vehicleId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  registrationNumber: { type: String, required: true, trim: true },
  makeModel: { type: String, default: '' },
  capacityTonne: { type: Number, default: 0 },
  trackerStatus: { type: String, enum: TRACKER_STATUSES, default: 'NotYetConfigured' },
  trackerProvider: { type: String, default: '' },
  trackerDeviceId: { type: String, default: '' },
  insuranceExpiry: { type: Date, default: null },
  fitnessExpiry: { type: Date, default: null },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
vehicleSchema.index({ organizationId: 1, facilityId: 1, registrationNumber: 1 }, { unique: true });
export const Vehicle = model('Vehicle', vehicleSchema);

const driverSchema = new Schema({
  driverId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  phone: { type: String, default: '' },
  licenseNumber: { type: String, default: '' },
  licenseExpiry: { type: Date, default: null },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
export const Driver = model('Driver', driverSchema);

/* ---------------------------------------------------------------- */
/* User → facility assignment (RBAC for cold operations)              */
/* ---------------------------------------------------------------- */

export const COLD_ROLES = ['OrgAdmin', 'FacilityManager', 'InventoryOperator', 'AccountsOperator', 'GateOperator', 'Auditor'] as const;
export type ColdRole = (typeof COLD_ROLES)[number];

const facilityUserSchema = new Schema({
  facilityUserId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  role: { type: String, enum: COLD_ROLES, required: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
facilityUserSchema.index({ facilityId: 1, userId: 1 }, { unique: true });
export const FacilityUser = model('FacilityUser', facilityUserSchema);
