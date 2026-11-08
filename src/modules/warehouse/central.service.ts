import { Facility, Vehicle, Employee, Party, FacilityUser, Organization } from './org.models.js';
import { InterFacilityTransfer, Trip, Gatepass } from './inventory.models.js';
import { Lot, Movement } from './inventory.models.js';
import { Bill } from './finance.models.js';
import { StorageLocation } from './master.models.js';
import { Device, Measurement } from './integration.models.js';

/** Network overview for the central administrator: every facility + aggregate posture. */
export async function networkOverview(): Promise<object> {
  const facilities = await Facility.find({ status: 'Active' }).sort({ name: 1 }).lean();
  const [lots, movements, transfers, trips, bills, vehicles, locations, measurements, devices, employees, parties, gatepasses, facilityUsers, organizations] = await Promise.all([
    Lot.find({ status: { $in: ['Active', 'PartiallyWithdrawn'] } }).lean(),
    Movement.find({}).sort({ createdAt: -1 }).limit(5).lean(),
    InterFacilityTransfer.find({}).sort({ createdAt: -1 }).limit(20).lean(),
    Trip.find({}).sort({ createdAt: -1 }).limit(20).lean(),
    Bill.find({ status: { $in: ['Posted', 'PartiallyPaid'] } }).lean(),
    Vehicle.find({}).lean(),
    StorageLocation.find({ status: 'Active' }).lean(),
    Measurement.find({}).sort({ measuredAt: -1 }).limit(2000).lean(),
    Device.find({}).lean(),
    Employee.find({ status: 'Active' }).lean(),
    Party.find({ status: 'Active' }).lean(),
    Gatepass.find({}).sort({ createdAt: -1 }).limit(200).lean(),
    FacilityUser.find({ status: 'Active' }).lean(),
    Organization.find({}).lean()
  ]);

  // Latest measurement per location:type for temperature rollup
  const latestMeasurement = new Map<string, { measurementType: string; value: number; unit: string; measuredAt: Date }>();
  for (const m of measurements) {
    const key = `${m.locationId}:${m.measurementType}`;
    if (!latestMeasurement.has(key)) latestMeasurement.set(key, { measurementType: m.measurementType, value: m.value, unit: m.unit, measuredAt: m.measuredAt });
  }

  const facilityRows = await Promise.all(facilities.map(async (facility) => {
    const facilityId = String(facility.facilityId);
    const lotsHere = lots.filter((lot) => lot.facilityId === facilityId);
    const stockQty = lotsHere.reduce((sum, lot) => sum + lot.currentQuantity, 0);
    const billAmounts = bills.filter((bill) => bill.facilityId === facilityId);
    const outstanding = billAmounts.reduce((sum, bill) => sum + (bill.total - bill.paidAmount), 0);
    const locationsHere = locations.filter((loc) => loc.facilityId === facilityId);
    const totalCapacityKg = locationsHere.reduce((sum, loc) => sum + (loc.capacityKg ?? 0), 0);
    const usedKg = lotsHere.reduce((sum, lot) => sum + lot.currentQuantity, 0);
    const org = organizations.find((o) => o.organizationId === facility.organizationId);
    const locationReadings = locationsHere.map((loc) => ({
      locationId: loc.locationId,
      name: loc.name,
      type: loc.type,
      minTempC: loc.minTempC,
      maxTempC: loc.maxTempC,
      readings: [...latestMeasurement.entries()]
        .filter(([key]) => key.startsWith(`${loc.locationId}:`))
        .map(([, m]) => ({ measurementType: m.measurementType, value: m.value, unit: m.unit, measuredAt: m.measuredAt }))
    }));
    return {
      facilityId, name: facility.name, code: facility.code, organizationId: facility.organizationId,
      address: facility.address, timezone: facility.timezone,
      freezingCapacityKg: facility.freezingCapacityKg, coldStorageCapacityKg: facility.coldStorageCapacityKg, ambientCapacityKg: facility.ambientCapacityKg,
      organizationName: org?.name ?? '',
      contactEmail: org?.contactEmail ?? '', contactPhone: org?.contactPhone ?? '',
      activeLots: lotsHere.length,
      stockQty,
      outstanding: Math.round(outstanding * 100) / 100,
      activeTrips: trips.filter((trip) => trip.facilityId === facilityId && ['Planned', 'Departed', 'Arrived'].includes(trip.status)).length,
      capacity: {
        locations: locationsHere.length,
        totalKg: totalCapacityKg,
        usedKg,
        availableKg: Math.max(0, totalCapacityKg - usedKg),
        utilizationPct: totalCapacityKg > 0 ? Math.round((usedKg / totalCapacityKg) * 1000) / 10 : 0
      },
      temperature: locationReadings,
      counts: {
        vehicles: vehicles.filter((v) => v.facilityId === facilityId).length,
        employees: employees.filter((e) => e.facilityId === facilityId).length,
        parties: parties.filter((p) => p.organizationId === facility.organizationId).length,
        devices: devices.filter((d) => d.facilityId === facilityId).length,
        gatepasses: gatepasses.filter((g) => g.facilityId === facilityId).length,
        facilityUsers: facilityUsers.filter((u) => u.facilityId === facilityId).length
      }
    };
  }));

  return {
    facilities: facilityRows,
    totalFacilities: facilities.length,
    totalActiveLots: lots.length,
    totalStockQty: lots.reduce((sum, lot) => sum + lot.currentQuantity, 0),
    totalOutstanding: Math.round(bills.reduce((sum, bill) => sum + (bill.total - bill.paidAmount), 0) * 100) / 100,
    totalTrips: trips.length,
    inTransitTransfers: transfers.filter((t) => ['Dispatched', 'InTransit'].includes(t.status)).length,
    recentMovements: movements,
    recentTransfers: transfers,
    recentTrips: trips,
    trackerStatusCounts: {
      configured: vehicles.filter((v) => v.trackerStatus === 'TrackerConfigured').length,
      notConfigured: vehicles.filter((v) => v.trackerStatus === 'NotYetConfigured').length,
      unavailable: vehicles.filter((v) => ['TrackerUnavailable', 'TemporarilyOffline', 'Disabled'].includes(v.trackerStatus)).length
    }
  };
}

/** Central admin list of facilities (full, not scoped). */
export async function centralListFacilities(): Promise<object[]> {
  return Facility.find({}).sort({ name: 1 }).lean();
}

/** Central admin: all transfers across the network. */
export async function centralListTransfers(input: { status?: string; page?: number; limit?: number }): Promise<object> {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    InterFacilityTransfer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    InterFacilityTransfer.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

/** Central admin: all trips across the network. */
export async function centralListTrips(input: { status?: string; page?: number; limit?: number }): Promise<object> {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Trip.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Trip.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}
