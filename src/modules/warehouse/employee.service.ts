import { ApiError } from '../../common/errors.js';
import { Facility } from './org.models.js';
import { Gatepass, InterFacilityTransfer, Trip, Movement } from './inventory.models.js';
import { Measurement } from './integration.models.js';
import { StorageLocation } from './master.models.js';

/**
 * Employee terminal.
 * An employee user is scoped to one facility (facilityId on the User). They see
 * live temperature, today's loading plan, yesterday's completed loading, and
 * their facility's vehicles/trips.
 */

export async function resolveEmployeeFacility(facilityId: string | undefined): Promise<{ facilityId: string; name: string }> {
  if (!facilityId) throw new ApiError(403, 'This employee identity has no linked facility', 'NO_FACILITY_LINK');
  const facility = await Facility.findOne({ facilityId }).lean();
  if (!facility) throw new ApiError(404, 'Linked facility was not found');
  return { facilityId: facility.facilityId, name: facility.name };
}

/** Live temperature & humidity per chamber at this facility. */
export async function employeeEnvironment(facilityId: string): Promise<object> {
  const facility = await resolveEmployeeFacility(facilityId);
  const locations = await StorageLocation.find({ facilityId, status: 'Active' }).lean();
  const locationIds = locations.map((loc) => loc.locationId);
  const measurements = await Measurement.find({ facilityId, locationId: { $in: locationIds } })
    .sort({ measuredAt: -1 }).limit(1000).lean();
  const latest = new Map<string, { measurementType: string; value: number; unit: string; measuredAt: Date }>();
  for (const m of measurements) {
    const key = `${m.locationId}:${m.measurementType}`;
    if (!latest.has(key)) latest.set(key, { measurementType: m.measurementType, value: m.value, unit: m.unit, measuredAt: m.measuredAt });
  }
  return {
    facility,
    locations: locations.map((loc) => ({
      locationId: loc.locationId,
      name: loc.name,
      type: loc.type,
      minTempC: loc.minTempC,
      maxTempC: loc.maxTempC,
      readings: [...latest.entries()]
        .filter(([key]) => key.startsWith(`${loc.locationId}:`))
        .map(([, m]) => ({ measurementType: m.measurementType, value: m.value, unit: m.unit, measuredAt: m.measuredAt }))
    }))
  };
}

/** Today's loading plan: gatepasses, transfers and trips for this facility today. */
export async function employeeToday(facilityId: string): Promise<object> {
  const facility = await resolveEmployeeFacility(facilityId);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const [gatepasses, transfers, trips] = await Promise.all([
    Gatepass.find({ facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean(),
    InterFacilityTransfer.find({ fromFacilityId: facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean(),
    Trip.find({ facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean()
  ]);
  return {
    facility,
    date: start.toISOString().slice(0, 10),
    gatepasses: gatepasses.map((g) => ({ gatepassNumber: g.gatepassNumber, type: g.type, status: g.status, createdAt: g.createdAt })),
    transfers: transfers.map((t) => ({ transferNumber: t.transferNumber, status: t.status, toFacilityId: t.toFacilityId, createdAt: t.createdAt })),
    trips: trips.map((t) => ({ tripNumber: t.tripNumber, status: t.status, vehicleId: t.vehicleId, createdAt: t.createdAt }))
  };
}

/** Yesterday's completed loading. */
export async function employeeYesterday(facilityId: string): Promise<object> {
  const facility = await resolveEmployeeFacility(facilityId);
  const start = new Date(); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setDate(end.getDate() - 1); end.setHours(23, 59, 59, 999);
  const [gatepasses, transfers, trips, movements] = await Promise.all([
    Gatepass.find({ facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean(),
    InterFacilityTransfer.find({ fromFacilityId: facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean(),
    Trip.find({ facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean(),
    Movement.find({ facilityId, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).limit(200).lean()
  ]);
  return {
    facility,
    date: start.toISOString().slice(0, 10),
    gatepasses: gatepasses.map((g) => ({ gatepassNumber: g.gatepassNumber, type: g.type, status: g.status, createdAt: g.createdAt })),
    transfers: transfers.map((t) => ({ transferNumber: t.transferNumber, status: t.status, toFacilityId: t.toFacilityId, createdAt: t.createdAt })),
    trips: trips.map((t) => ({ tripNumber: t.tripNumber, status: t.status, vehicleId: t.vehicleId, createdAt: t.createdAt })),
    movements: movements.map((m) => ({ movementId: m.movementId, type: m.type, lotId: m.lotId, quantity: m.quantity, createdAt: m.createdAt }))
  };
}

/** Facility vehicles & trips (for the employee's dispatch view). */
export async function employeeFleet(facilityId: string): Promise<object> {
  const facility = await resolveEmployeeFacility(facilityId);
  const vehicles = await import('./org.models.js').then((m) => m.Vehicle.find({ facilityId }).sort({ registrationNumber: 1 }).lean());
  const trips = await Trip.find({ facilityId }).sort({ createdAt: -1 }).limit(50).lean();
  return {
    facility,
    vehicles: vehicles.map((v) => ({
      vehicleId: v.vehicleId, registrationNumber: v.registrationNumber, makeModel: v.makeModel,
      capacityTonne: v.capacityTonne, trackerStatus: v.trackerStatus, status: v.status
    })),
    trips: trips.map((t) => ({ tripNumber: t.tripNumber, status: t.status, vehicleId: t.vehicleId, departureAt: t.departureAt, arrivalAt: t.arrivalAt }))
  };
}