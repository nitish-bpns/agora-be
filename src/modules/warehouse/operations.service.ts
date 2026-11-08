import mongoose from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Lot, Gatepass, GenealogyEvent, InterFacilityTransfer, Movement, OwnershipEvent, Trip } from './inventory.models.js';
import { Vehicle } from './org.models.js';
import { requireFacilityInOrg } from './scoping.js';
import { isInventoryRole } from './context.js';
import { assertLienFree } from './pledge.service.js';

const AUDIT_REALM = 'Storage';

function requireOpsRole(role: string): void {
  if (!isInventoryRole(role)) throw new ApiError(403, 'This operation requires an inventory-role identity', 'COLD_FORBIDDEN');
}

/* ------------------------------------------------------------------ */
/* Gatepasses                                                          */
/* ------------------------------------------------------------------ */

export async function createGatepass(input: {
  organizationId: string; facilityId: string; type: string; partyId?: string | null;
  vehicleId?: string | null; driverId?: string | null; transportReference?: string;
  items: Array<{ lotId?: string | null; commodityId: string; quantity: number; unitId: string; packageCount?: number }>;
  clientOpId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  await requireFacilityInOrg(input.organizationId, input.facilityId);
  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      const dup = await Gatepass.findOne({ clientOpId: input.clientOpId ?? '' }).session(session);
      if (dup) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');
      const gatepassId = await nextId('gatepass');
      const [gatepass] = await Gatepass.create([{
        gatepassId, organizationId: input.organizationId, facilityId: input.facilityId, gatepassNumber: gatepassId,
        type: input.type, status: 'Draft', partyId: input.partyId ?? null, vehicleId: input.vehicleId ?? null,
        driverId: input.driverId ?? null, transportReference: input.transportReference ?? '',
        items: input.items, actorId, clientOpId: input.clientOpId ?? null
      }], { session });
      result = gatepass!.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'gatepasses', recordId: String((result as { gatepassId?: string }).gatepassId ?? ''), action: 'Create', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function openGatepass(input: { organizationId: string; facilityId: string; gatepassId: string }, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const gatepass = await Gatepass.findOne({ gatepassId: input.gatepassId, organizationId: input.organizationId }).session(session);
      if (!gatepass) throw new ApiError(404, `Gatepass ${input.gatepassId} was not found`);
      if (gatepass.status !== 'Draft') throw new ApiError(409, `Gatepass is ${gatepass.status}, expected Draft`);
      gatepass.status = 'Open';
      gatepass.openedAt = new Date();
      await gatepass.save({ session });
      result = gatepass.toObject();
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

export async function completeGatepass(input: { organizationId: string; facilityId: string; gatepassId: string }, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const gatepass = await Gatepass.findOne({ gatepassId: input.gatepassId, organizationId: input.organizationId }).session(session);
      if (!gatepass) throw new ApiError(404, `Gatepass ${input.gatepassId} was not found`);
      if (!['Open', 'Approved'].includes(gatepass.status)) throw new ApiError(409, `Gatepass is ${gatepass.status}, expected Open/Approved`);
      gatepass.status = 'Completed';
      gatepass.closedAt = new Date();
      await gatepass.save({ session });
      // outward movements for outward-type gatepasses
      if (gatepass.type === 'Outward') {
        for (const item of gatepass.items) {
          if (!item.lotId) continue;
          const lot = await Lot.findOne({ lotId: item.lotId, organizationId: input.organizationId }).session(session);
          if (!lot) throw new ApiError(404, `Lot ${item.lotId} was not found`);
          if (lot.currentQuantity + 1e-9 < item.quantity) throw new ApiError(409, `Insufficient stock on lot ${item.lotId}`, 'INSUFFICIENT_STOCK');
          assertLienFree(lot, item.quantity, 'Gatepass outward');
          lot.currentQuantity = Number((lot.currentQuantity - item.quantity).toFixed(10));
          lot.status = lot.currentQuantity <= 1e-9 ? 'Withdrawn' : 'PartiallyWithdrawn';
          if (lot.status === 'Withdrawn') lot.closedAt = new Date();
          await lot.save({ session });
          await Movement.create([{
            movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: lot.lotId,
            type: 'Outward', direction: 'Out', quantity: item.quantity, weightKg: 0, packageCount: item.packageCount ?? 0,
            unitId: item.unitId, fromLocationId: lot.locationId, reason: `Gatepass ${gatepass.gatepassNumber}`,
            actorId, referenceType: 'gatepass', referenceId: gatepass.gatepassId
          }], { session });
        }
      }
      result = gatepass.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'gatepasses', recordId: input.gatepassId, action: 'Complete', actorId });
    return result!;
  } finally {
    await session.endSession();
  }
}

export async function listGatepasses(input: { organizationId: string; facilityId?: string; status?: string; type?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.facilityId) filter.facilityId = input.facilityId;
  if (input.status) filter.status = input.status;
  if (input.type) filter.type = input.type;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Gatepass.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Gatepass.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

/* ------------------------------------------------------------------ */
/* Inter-facility transfers                                            */
/* ------------------------------------------------------------------ */

export async function createTransfer(input: {
  organizationId: string; fromFacilityId: string; toFacilityId: string;
  items: Array<{ lotId: string; commodityId: string; quantity: number; unitId: string; packageCount?: number }>;
  vehicleId?: string | null; driverId?: string | null; note?: string;
}, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  if (input.fromFacilityId === input.toFacilityId) throw new ApiError(400, 'Origin and destination facilities must differ');
  await requireFacilityInOrg(input.organizationId, input.fromFacilityId);
  await requireFacilityInOrg(input.organizationId, input.toFacilityId);
  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      for (const item of input.items) {
        const lot = await Lot.findOne({ lotId: item.lotId, organizationId: input.organizationId }).session(session);
        if (!lot) throw new ApiError(404, `Lot ${item.lotId} was not found`);
        if (lot.facilityId !== input.fromFacilityId) throw new ApiError(409, `Lot ${item.lotId} is not at the origin facility`);
        if (lot.currentQuantity + 1e-9 < item.quantity) throw new ApiError(409, `Insufficient stock on lot ${item.lotId}`, 'INSUFFICIENT_STOCK');
        assertLienFree(lot, item.quantity, 'Transfer dispatch');
      }
      const transferId = await nextId('interFacilityTransfer');
      const [transfer] = await InterFacilityTransfer.create([{
        transferId, organizationId: input.organizationId, transferNumber: transferId,
        fromFacilityId: input.fromFacilityId, toFacilityId: input.toFacilityId, status: 'Draft',
        items: input.items, vehicleId: input.vehicleId ?? null, driverId: input.driverId ?? null,
        actorId, note: input.note ?? ''
      }], { session });
      result = transfer!.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'transfers', recordId: String((result as { transferId?: string }).transferId ?? ''), action: 'Create', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function dispatchTransfer(input: { organizationId: string; transferId: string }, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const transfer = await InterFacilityTransfer.findOne({ transferId: input.transferId, organizationId: input.organizationId }).session(session);
      if (!transfer) throw new ApiError(404, `Transfer ${input.transferId} was not found`);
      if (transfer.status !== 'Draft') throw new ApiError(409, `Transfer is ${transfer.status}`);
      for (const item of transfer.items) {
        const lot = await Lot.findOne({ lotId: item.lotId, organizationId: input.organizationId }).session(session);
        if (!lot) throw new ApiError(404, `Lot ${item.lotId} was not found`);
        if (lot.currentQuantity + 1e-9 < item.quantity) throw new ApiError(409, `Insufficient stock on lot ${item.lotId}`, 'INSUFFICIENT_STOCK');
        assertLienFree(lot, item.quantity, 'Transfer dispatch');
        lot.currentQuantity = Number((lot.currentQuantity - item.quantity).toFixed(10));
        lot.status = lot.currentQuantity <= 1e-9 ? 'Transferred' : 'PartiallyWithdrawn';
        if (lot.status === 'Transferred') lot.closedAt = new Date();
        await lot.save({ session });
        await Movement.create([{
          movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: transfer.fromFacilityId, lotId: lot.lotId,
          type: 'TransferDispatch', direction: 'Out', quantity: item.quantity, weightKg: 0, packageCount: item.packageCount ?? 0,
          unitId: item.unitId, reason: `Transfer ${transfer.transferNumber}`, actorId, referenceType: 'transfer', referenceId: transfer.transferId
        }], { session });
        await GenealogyEvent.create([{
          eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: transfer.fromFacilityId,
          type: 'Transfer', sourceLotIds: [lot.lotId], targetLotIds: [], quantitiesBefore: { [lot.lotId]: lot.currentQuantity + item.quantity },
          quantitiesAfter: { [lot.lotId]: lot.currentQuantity }, unitId: item.unitId, reason: `Dispatch ${transfer.transferNumber}`, actorId
        }], { session });
      }
      transfer.status = 'Dispatched';
      transfer.dispatchedAt = new Date();
      await transfer.save({ session });
      result = transfer.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'transfers', recordId: input.transferId, action: 'Dispatch', actorId });
    return result!;
  } finally {
    await session.endSession();
  }
}

export async function receiveTransfer(input: { organizationId: string; transferId: string; receivedItems?: Array<{ lotId: string; receivedQty: number; damageQty?: number; note?: string }> }, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const transfer = await InterFacilityTransfer.findOne({ transferId: input.transferId, organizationId: input.organizationId }).session(session);
      if (!transfer) throw new ApiError(404, `Transfer ${input.transferId} was not found`);
      if (!['Dispatched', 'InTransit'].includes(transfer.status)) throw new ApiError(409, `Transfer is ${transfer.status}`);
      const discrepancies = [];
      for (const item of transfer.items) {
        const received = input.receivedItems?.find((r) => r.lotId === item.lotId);
        const receivedQty = received?.receivedQty ?? item.quantity;
        const damageQty = received?.damageQty ?? 0;
        if (receivedQty + damageQty > item.quantity + 1e-9) throw new ApiError(409, `Received quantity exceeds dispatched for ${item.lotId}`);
        // create a new lot at destination with the received (good) quantity
        const sourceLot = await Lot.findOne({ lotId: item.lotId, organizationId: input.organizationId }).session(session).lean();
        if (!sourceLot) throw new ApiError(404, `Source lot ${item.lotId} was not found`);
        if (receivedQty > 1e-9) {
          const newLotId = await nextId('lot');
          await Lot.create([{
            lotId: newLotId, organizationId: input.organizationId, facilityId: transfer.toFacilityId, lotNumber: newLotId,
            commodityId: item.commodityId, varietyId: sourceLot.varietyId, packagingId: sourceLot.packagingId,
            quantityUnitId: item.unitId, ownerId: sourceLot.ownerId, custodianFacilityId: transfer.toFacilityId,
            locationId: null, palletId: null, openingQuantity: receivedQty, currentQuantity: receivedQty,
            packageCount: item.packageCount ?? 0, isOperatorOwned: sourceLot.isOperatorOwned,
            status: 'Active', notes: `Received from transfer ${transfer.transferNumber}`
          }], { session });
          await Movement.create([{
            movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: transfer.toFacilityId, lotId: newLotId,
            type: 'TransferReceive', direction: 'In', quantity: receivedQty, weightKg: 0, packageCount: item.packageCount ?? 0,
            unitId: item.unitId, toOwnerId: sourceLot.ownerId, reason: `Transfer ${transfer.transferNumber}`, actorId,
            referenceType: 'transfer', referenceId: transfer.transferId
          }], { session });
          await OwnershipEvent.create([{
            eventId: await nextId('ownershipEvent'), organizationId: input.organizationId, lotId: newLotId,
            type: 'Transfer', toOwnerId: sourceLot.ownerId, quantity: receivedQty, facilityId: transfer.toFacilityId,
            reason: `Received from transfer ${transfer.transferNumber}`, actorId
          }], { session });
          await GenealogyEvent.create([{
            eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: transfer.toFacilityId,
            type: 'Transfer', sourceLotIds: [item.lotId], targetLotIds: [newLotId],
            quantitiesBefore: {}, quantitiesAfter: { [newLotId]: receivedQty }, unitId: item.unitId,
            reason: `Receive ${transfer.transferNumber}`, actorId
          }], { session });
        }
        if (receivedQty !== item.quantity || damageQty > 0) {
          discrepancies.push({ lotId: item.lotId, expectedQty: item.quantity, receivedQty, damageQty, unitId: item.unitId, note: received?.note ?? '' });
        }
      }
      transfer.receivedAt = new Date();
      if (discrepancies.length > 0) {
        transfer.status = 'ReceivedWithDiscrepancy';
        transfer.set('discrepancies', discrepancies);
      } else {
        transfer.status = 'Delivered';
      }
      await transfer.save({ session });
      result = transfer.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'transfers', recordId: input.transferId, action: 'Receive', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

export async function listTransfers(input: { organizationId: string; facilityId?: string; status?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.facilityId) filter.$or = [{ fromFacilityId: input.facilityId }, { toFacilityId: input.facilityId }];
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    InterFacilityTransfer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    InterFacilityTransfer.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

/* ------------------------------------------------------------------ */
/* Trips (tracker-optional)                                            */
/* ------------------------------------------------------------------ */

export async function createTrip(input: {
  organizationId: string; facilityId: string; transferId?: string | null; vehicleId: string; driverId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  await requireFacilityInOrg(input.organizationId, input.facilityId);
  const vehicle = await Vehicle.findOne({ vehicleId: input.vehicleId, organizationId: input.organizationId }).lean();
  if (!vehicle) throw new ApiError(404, `Vehicle ${input.vehicleId} was not found`);
  const tripId = await nextId('trip');
  const trip = await Trip.create({
    tripId, organizationId: input.organizationId, facilityId: input.facilityId, tripNumber: tripId,
    transferId: input.transferId ?? null, vehicleId: input.vehicleId, driverId: input.driverId ?? null,
    status: 'Planned', trackingAvailable: ['TrackerConfigured'].includes(vehicle.trackerStatus as string), actorId
  });
  await recordAudit({ realm: AUDIT_REALM, collection: 'trips', recordId: tripId, action: 'Create', actorId, metadata: input });
  return trip.toObject();
}

export async function updateTripStatus(input: { organizationId: string; tripId: string; status: string; note?: string }, actorId: string, role: string): Promise<object> {
  requireOpsRole(role);
  const trip = await Trip.findOne({ tripId: input.tripId, organizationId: input.organizationId });
  if (!trip) throw new ApiError(404, `Trip ${input.tripId} was not found`);
  const transitions: Record<string, string[]> = { Planned: ['Departed', 'Cancelled'], Departed: ['Arrived', 'Cancelled'], Arrived: ['Completed'], Completed: [], Cancelled: [] };
  if (!transitions[trip.status as string]?.includes(input.status)) throw new ApiError(409, `Trip cannot transition ${trip.status} -> ${input.status}`);
  trip.status = input.status as 'Planned' | 'Departed' | 'Arrived' | 'Completed' | 'Cancelled';
  if (input.status === 'Departed') trip.departureAt = new Date();
  if (input.status === 'Arrived') trip.arrivalAt = new Date();
  if (input.status === 'Departed') trip.departureNote = input.note ?? '';
  if (input.status === 'Arrived') trip.arrivalNote = input.note ?? '';
  await trip.save();
  await recordAudit({ realm: AUDIT_REALM, collection: 'trips', recordId: input.tripId, action: `Status -> ${input.status}`, actorId, metadata: { note: input.note } });
  return trip.toObject();
}

export async function listTrips(input: { organizationId: string; facilityId?: string; status?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.facilityId) filter.facilityId = input.facilityId;
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Trip.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Trip.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}
