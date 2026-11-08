import { ApiError } from '../../common/errors.js';
import { Party } from './org.models.js';
import { Lot, Movement, Gatepass, InterFacilityTransfer, Trip } from './inventory.models.js';
import { Bill, Payment } from './finance.models.js';
import { Measurement, Device } from './integration.models.js';
import { StorageLocation } from './master.models.js';

/**
 * Customer / depositor terminal.
 * A customer user is linked to a Party (via partyId on the User). They can see
 * every lot they own across ALL facilities, live temperature at their lots,
 * loading events (gatepasses/transfers/trips) and their bills & payments.
 */

export async function resolveCustomerParty(partyId: string | undefined): Promise<{ partyId: string; name: string }> {
  if (!partyId) throw new ApiError(403, 'This customer identity has no linked party', 'NO_PARTY_LINK');
  const party = await Party.findOne({ partyId }).lean();
  if (!party) throw new ApiError(404, 'Linked party was not found');
  return { partyId: party.partyId, name: party.name };
}

/** All lots owned by this customer across every facility. */
export async function customerStock(partyId: string): Promise<object> {
  const party = await resolveCustomerParty(partyId);
  const lots = await Lot.find({ ownerId: partyId, status: { $in: ['Active', 'PartiallyWithdrawn', 'Held'] } })
    .sort({ createdAt: -1 }).lean();
  const facilityIds = [...new Set(lots.map((lot) => lot.facilityId))];
  const facilities = await Promise.all(facilityIds.map(async (facilityId) => {
    const facility = await import('./org.models.js').then((m) => m.Facility.findOne({ facilityId }).lean());
    return facility ? { facilityId, name: facility.name, code: facility.code } : { facilityId, name: facilityId, code: '' };
  }));
  const locationIds = [...new Set(lots.map((lot) => lot.locationId))];
  const locations = await StorageLocation.find({ locationId: { $in: locationIds } }).lean();
  const locationMap = new Map(locations.map((loc) => [loc.locationId, loc.name]));
  const commodityIds = [...new Set(lots.map((lot) => lot.commodityId))];
  const commodities = await import('./master.models.js').then((m) => m.Commodity.find({ commodityId: { $in: commodityIds } }).lean());
  const commodityMap = new Map(commodities.map((c) => [c.commodityId, c.name]));

  const rows = lots.map((lot) => ({
    lotId: lot.lotId,
    lotNumber: lot.lotNumber,
    facilityId: lot.facilityId,
    facilityName: facilities.find((f) => f.facilityId === lot.facilityId)?.name ?? lot.facilityId,
    commodityId: lot.commodityId,
    commodityName: commodityMap.get(lot.commodityId) ?? lot.commodityId,
    locationId: lot.locationId,
    locationName: locationMap.get(lot.locationId) ?? lot.locationId,
    currentQuantity: lot.currentQuantity,
    unitId: lot.quantityUnitId,
    packageCount: lot.packageCount,
    // Lien: how much of this lot is pledged (locked to financers).
    pledgedQuantity: lot.pledgedQuantity ?? 0,
    freeQuantity: Math.max(0, Number((Number(lot.currentQuantity) - Number(lot.pledgedQuantity ?? 0)).toFixed(10))),
    pledgeStatus: lot.pledgeStatus ?? 'Unpledged',
    status: lot.status,
    createdAt: lot.createdAt
  }));

  return {
    party,
    totalLots: rows.length,
    totalQuantity: rows.reduce((sum, lot) => sum + lot.currentQuantity, 0),
    facilities: facilities.length,
    lots: rows
  };
}

/** Live temperature/humidity at the locations holding this customer's lots. */
export async function customerEnvironment(partyId: string): Promise<object> {
  const lots = await Lot.find({ ownerId: partyId, status: { $in: ['Active', 'PartiallyWithdrawn', 'Held'] } }).select('locationId facilityId').lean();
  const locationIds = [...new Set(lots.map((lot) => lot.locationId))];
  const measurements = await Measurement.find({ locationId: { $in: locationIds } })
    .sort({ measuredAt: -1 }).limit(500).lean();
  const latest = new Map<string, { measurementType: string; value: number; unit: string; measuredAt: Date }>();
  for (const m of measurements) {
    const key = `${m.locationId}:${m.measurementType}`;
    if (!latest.has(key)) latest.set(key, { measurementType: m.measurementType, value: m.value, unit: m.unit, measuredAt: m.measuredAt });
  }
  const locations = await StorageLocation.find({ locationId: { $in: locationIds } }).lean();
  return {
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

/** Loading events: gatepasses, transfers and trips touching this customer's lots. */
export async function customerLoadingEvents(partyId: string, days = 14): Promise<object> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const lots = await Lot.find({ ownerId: partyId }).select('lotId lotNumber').lean();
  const lotIds = lots.map((lot) => lot.lotId);
  const [gatepasses, transfers, trips, movements] = await Promise.all([
    Gatepass.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
    InterFacilityTransfer.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
    Trip.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
    Movement.find({ lotId: { $in: lotIds }, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(200).lean()
  ]);
  const facilityIds = [...new Set([
    ...gatepasses.map((g) => g.facilityId),
    ...transfers.flatMap((t) => [t.fromFacilityId, t.toFacilityId]),
    ...trips.map((t) => t.facilityId)
  ].filter(Boolean))];
  const facilities = await import('./org.models.js').then((m) => m.Facility.find({ facilityId: { $in: facilityIds } }).lean());
  const facilityMap = new Map(facilities.map((f) => [f.facilityId, f.name]));

  return {
    movements: movements.map((m) => ({
      movementId: m.movementId, type: m.type, lotId: m.lotId, quantity: m.quantity,
      facilityId: m.facilityId, facilityName: facilityMap.get(m.facilityId) ?? m.facilityId,
      createdAt: m.createdAt
    })),
    gatepasses: gatepasses.map((g) => ({
      gatepassNumber: g.gatepassNumber, type: g.type, status: g.status,
      facilityId: g.facilityId, facilityName: facilityMap.get(g.facilityId) ?? g.facilityId,
      createdAt: g.createdAt
    })),
    transfers: transfers.map((t) => ({
      transferNumber: t.transferNumber, status: t.status,
      fromFacilityId: t.fromFacilityId, fromFacilityName: facilityMap.get(t.fromFacilityId) ?? t.fromFacilityId,
      toFacilityId: t.toFacilityId, toFacilityName: facilityMap.get(t.toFacilityId) ?? t.toFacilityId,
      createdAt: t.createdAt
    })),
    trips: trips.map((t) => ({
      tripNumber: t.tripNumber, status: t.status, vehicleId: t.vehicleId,
      facilityId: t.facilityId, facilityName: facilityMap.get(t.facilityId) ?? t.facilityId,
      trackingAvailable: t.trackingAvailable, createdAt: t.createdAt
    }))
  };
}

/** Bills and payments for this customer across all facilities. */
export async function customerFinance(partyId: string): Promise<object> {
  const party = await resolveCustomerParty(partyId);
  const [bills, payments] = await Promise.all([
    Bill.find({ customerId: partyId }).sort({ billDate: -1 }).limit(200).lean(),
    Payment.find({ partyId, paymentType: 'Receipt' }).sort({ paymentDate: -1 }).limit(200).lean()
  ]);
  const outstanding = bills.reduce((sum, bill) => sum + (bill.total - bill.paidAmount), 0);
  const facilityIds = [...new Set(bills.map((b) => b.facilityId))];
  const facilities = await import('./org.models.js').then((m) => m.Facility.find({ facilityId: { $in: facilityIds } }).lean());
  const facilityMap = new Map(facilities.map((f) => [f.facilityId, f.name]));
  return {
    party,
    summary: {
      totalBilled: bills.reduce((sum, b) => sum + b.total, 0),
      totalPaid: bills.reduce((sum, b) => sum + b.paidAmount, 0),
      outstanding,
      openBills: bills.filter((b) => ['Posted', 'PartiallyPaid'].includes(b.status)).length
    },
    bills: bills.map((b) => ({
      billId: b.billId, billNumber: b.billNumber, billDate: b.billDate, dueDate: b.dueDate,
      facilityId: b.facilityId, facilityName: facilityMap.get(b.facilityId) ?? b.facilityId,
      total: b.total, paidAmount: b.paidAmount, status: b.status
    })),
    payments: payments.map((p) => ({
      paymentId: p.paymentId, paymentDate: p.paymentDate, method: p.method,
      referenceNumber: p.referenceNumber, amount: p.amount
    }))
  };
}

/** Camera devices at the locations holding this customer's lots (Phase 2 live streams). */
export async function customerCameras(partyId: string): Promise<object> {
  const lots = await Lot.find({ ownerId: partyId, status: { $in: ['Active', 'PartiallyWithdrawn', 'Held'] } }).select('locationId facilityId').lean();
  const locationIds = [...new Set(lots.map((lot) => lot.locationId))];
  const cameras = await Device.find({ category: 'Camera', locationId: { $in: locationIds } }).lean();
  const locations = await StorageLocation.find({ locationId: { $in: locationIds } }).lean();
  const locationMap = new Map(locations.map((loc) => [loc.locationId, loc.name]));
  return {
    cameras: cameras.map((c) => ({
      deviceId: c.deviceId, model: c.model, serialNumber: c.serialNumber,
      locationId: c.locationId, locationName: locationMap.get(c.locationId ?? '') ?? c.locationId ?? '—',
      status: c.status, enabled: c.enabled, lastSuccessfulCommAt: c.lastSuccessfulCommAt
    }))
  };
}