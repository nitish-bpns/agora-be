import mongoose, { type ClientSession } from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Lot } from '../warehouse/inventory.models.js';
import { GenealogyEvent, Movement, OwnershipEvent } from './inventory.models.js';
import { StorageLocation, Pallet } from './master.models.js';
import { requireFacilityInOrg } from './scoping.js';
import { isInventoryRole } from './context.js';
import { assertLienFree, derivePledgeStatus } from './pledge.service.js';

const AUDIT_REALM = 'Storage';

/* ------------------------------------------------------------------ */
/* Capacity computation                                                */
/* ------------------------------------------------------------------ */

async function occupiedKg(location: { locationId: string }): Promise<{ usedKg: number; usedBags: number }> {
  const lots = await Lot.find({ locationId: location.locationId, status: { $in: ['Active', 'PartiallyWithdrawn'] } }).lean();
  let usedKg = 0;
  let usedBags = 0;
  for (const lot of lots) {
    usedKg += lot.currentQuantity * (lot.openingQuantity > 0 ? 1 : 1); // weight conversion handled by caller using unit kg
    usedBags += lot.packageCount;
  }
  return { usedKg, usedBags };
}

export async function capacityOverview(facilityId: string): Promise<{ totalKg: number; usedKg: number; availableKg: number; totalBags: number; usedBags: number; availableBags: number; locations: Array<{ locationId: string; name: string; usedKg: number; capacityKg: number; usedBags: number; capacityBags: number; availableKg: number; availableBags: number }> }> {
  const locations = await StorageLocation.find({ facilityId, status: { $in: ['Active', 'Maintenance'] } }).lean();
  const summary: { totalKg: number; usedKg: number; availableKg: number; totalBags: number; usedBags: number; availableBags: number; locations: Array<{ locationId: string; name: string; usedKg: number; capacityKg: number; usedBags: number; capacityBags: number; availableKg: number; availableBags: number }> } = { totalKg: 0, usedKg: 0, availableKg: 0, totalBags: 0, usedBags: 0, availableBags: 0, locations: [] };
  for (const location of locations) {
    const { usedKg, usedBags } = await occupiedKg(location);
    const capacityKg = location.capacityKg ?? 0;
    const capacityBags = location.capacityBags ?? 0;
    summary.totalKg += capacityKg;
    summary.usedKg += usedKg;
    summary.availableKg += Math.max(0, capacityKg - usedKg - (location.reservedKg ?? 0) - (location.unavailableKg ?? 0));
    summary.totalBags += capacityBags;
    summary.usedBags += usedBags;
    summary.availableBags += Math.max(0, capacityBags - usedBags);
    summary.locations.push({ locationId: (location as unknown as { locationId: string }).locationId, name: location.name, usedKg, capacityKg, usedBags, capacityBags, availableKg: Math.max(0, capacityKg - usedKg - (location.reservedKg ?? 0) - (location.unavailableKg ?? 0)), availableBags: Math.max(0, capacityBags - usedBags) });
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

async function isDuplicate(clientOpId?: string | null, session?: ClientSession): Promise<boolean> {
  if (!clientOpId) return false;
  const existing = await Movement.findOne({ clientOpId }).session(session ?? null);
  return Boolean(existing);
}

function requireInventoryRole(role: string): void {
  if (!isInventoryRole(role)) throw new ApiError(403, 'Inventory operations require an inventory-role identity', 'COLD_FORBIDDEN');
}

/* ------------------------------------------------------------------ */
/* Inward                                                              */
/* ------------------------------------------------------------------ */

export async function recordInward(input: {
  organizationId: string; facilityId: string; commodityId: string; varietyId?: string | null;
  unitId: string; quantity: number; weightKg?: number; packageCount?: number; packagingId?: string | null;
  ownerId: string; locationId: string; palletId?: string | null; isOperatorOwned?: boolean;
  lotNumber?: string | null; clientOpId?: string | null; notes?: string; lotId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  if (input.quantity <= 0) throw new ApiError(400, 'Quantity must be positive');
  await requireFacilityInOrg(input.organizationId, input.facilityId);
  const location = await StorageLocation.findOne({ locationId: input.locationId, facilityId: input.facilityId }).lean();
  if (!location) throw new ApiError(404, `Storage location ${input.locationId} was not found`);

  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      if (await isDuplicate(input.clientOpId, session)) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');

      const lotId = await nextId('lot');
      const movementId = await nextId('movement');
      const lotNumber = input.lotNumber ?? lotId;
      const [createdLot] = await Lot.create([{
        lotId, organizationId: input.organizationId, facilityId: input.facilityId, lotNumber,
        commodityId: input.commodityId, varietyId: input.varietyId ?? null, packagingId: input.packagingId ?? null,
        quantityUnitId: input.unitId, ownerId: input.ownerId, custodianFacilityId: input.facilityId,
        locationId: input.locationId, palletId: input.palletId ?? null,
        openingQuantity: input.quantity, currentQuantity: input.quantity, packageCount: input.packageCount ?? 0,
        isOperatorOwned: input.isOperatorOwned ?? false, notes: input.notes ?? '', status: 'Active'
      }], { session });
      await Movement.create([{
        movementId, organizationId: input.organizationId, facilityId: input.facilityId, lotId,
        type: 'Inward', direction: 'In', quantity: input.quantity, weightKg: input.weightKg ?? 0,
        packageCount: input.packageCount ?? 0, unitId: input.unitId, toLocationId: input.locationId,
        toOwnerId: input.ownerId, reason: 'Inward entry', actorId, clientOpId: input.clientOpId ?? null
      }], { session });
      await GenealogyEvent.create([{
        eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: input.facilityId,
        type: 'Inward', sourceLotIds: [], targetLotIds: [lotId], quantitiesBefore: {}, quantitiesAfter: { [lotId]: input.quantity },
        unitId: input.unitId, reason: 'Inward entry', actorId, createdAt: new Date()
      }], { session });
      await OwnershipEvent.create([{
        eventId: await nextId('ownershipEvent'), organizationId: input.organizationId, lotId,
        type: 'Create', toOwnerId: input.ownerId, quantity: input.quantity, facilityId: input.facilityId,
        reason: 'Inward entry', actorId
      }], { session });
      if (input.palletId) await Pallet.updateOne({ palletId: input.palletId }, { $set: { status: 'InUse' } }).session(session);
      result = createdLot!.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'movements', recordId: String((result as { lotNumber?: string }).lotNumber ?? ''), action: 'Inward', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function recordOutward(input: {
  organizationId: string; facilityId: string; lotId: string; quantity: number; unitId: string;
  weightKg?: number; packageCount?: number; reason?: string; reasonCode?: string;
  authorizedById?: string | null; clientOpId?: string | null; gatepassId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  if (input.quantity <= 0) throw new ApiError(400, 'Quantity must be positive');
  await requireFacilityInOrg(input.organizationId, input.facilityId);

  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      if (await isDuplicate(input.clientOpId, session)) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');

      const lot = await Lot.findOne({ lotId: input.lotId, organizationId: input.organizationId }).session(session);
      if (!lot) throw new ApiError(404, `Lot ${input.lotId} was not found`);
      if (lot.facilityId !== input.facilityId) throw new ApiError(409, 'Lot is not held at this facility');
      if (!['Active', 'PartiallyWithdrawn'].includes(lot.status)) throw new ApiError(409, `Lot ${lot.lotId} is ${lot.status} and cannot be withdrawn`);
      if (lot.currentQuantity + 1e-9 < input.quantity) {
        throw new ApiError(409, `Insufficient stock: lot has ${lot.currentQuantity} ${lot.quantityUnitId}, asked ${input.quantity}`, 'INSUFFICIENT_STOCK');
      }
      // Lien check: pledged quantity is held by financers and cannot leave the facility.
      assertLienFree(lot, input.quantity, 'Outward withdrawal');

      lot.currentQuantity = Number((lot.currentQuantity - input.quantity).toFixed(10));
      if (lot.currentQuantity <= 1e-9) {
        lot.currentQuantity = 0;
        lot.status = 'Withdrawn';
        lot.closedAt = new Date();
      } else {
        lot.status = 'PartiallyWithdrawn';
      }
      await lot.save({ session });

      const movementId = await nextId('movement');
      await Movement.create([{
        movementId, organizationId: input.organizationId, facilityId: input.facilityId, lotId: lot.lotId,
        type: 'Outward', direction: 'Out', quantity: input.quantity, weightKg: input.weightKg ?? 0,
        packageCount: input.packageCount ?? 0, unitId: input.unitId, fromLocationId: lot.locationId,
        reason: input.reason ?? 'Outward entry', reasonCode: input.reasonCode ?? '',
        authorizedById: input.authorizedById ?? null, actorId, referenceType: input.gatepassId ? 'gatepass' : '', referenceId: input.gatepassId ?? null,
        clientOpId: input.clientOpId ?? null
      }], { session });
      await GenealogyEvent.create([{
        eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: input.facilityId,
        type: 'Outward', sourceLotIds: [lot.lotId], targetLotIds: [], quantitiesBefore: { [lot.lotId]: lot.currentQuantity + input.quantity },
        quantitiesAfter: { [lot.lotId]: lot.currentQuantity }, unitId: input.unitId,
        reason: input.reason ?? 'Outward entry', actorId
      }], { session });
      result = lot.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'movements', recordId: input.lotId, action: 'Outward', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Relocate                                                            */
/* ------------------------------------------------------------------ */

export async function relocateLot(input: {
  organizationId: string; facilityId: string; lotId: string; toLocationId: string; palletId?: string | null; reason?: string;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  await requireFacilityInOrg(input.organizationId, input.facilityId);
  const toLocation = await StorageLocation.findOne({ locationId: input.toLocationId, facilityId: input.facilityId }).lean();
  if (!toLocation) throw new ApiError(404, `Storage location ${input.toLocationId} was not found`);

  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const lot = await Lot.findOne({ lotId: input.lotId, organizationId: input.organizationId }).session(session);
      if (!lot) throw new ApiError(404, `Lot ${input.lotId} was not found`);
      if (lot.facilityId !== input.facilityId) throw new ApiError(409, 'Lot is not held at this facility');
      const fromLocationId = lot.locationId;
      lot.locationId = input.toLocationId;
      lot.palletId = input.palletId == null ? lot.palletId : input.palletId;
      await lot.save({ session });
      await Movement.create([{
        movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: lot.lotId,
        type: 'Relocate', direction: 'In', quantity: lot.currentQuantity, weightKg: 0, packageCount: lot.packageCount,
        unitId: lot.quantityUnitId, fromLocationId, toLocationId: input.toLocationId,
        reason: input.reason ?? 'Relocation', actorId
      }], { session });
      result = lot.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'lots', recordId: input.lotId, action: 'Relocate', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Adjustment                                                          */
/* ------------------------------------------------------------------ */

export async function adjustLot(input: {
  organizationId: string; facilityId: string; lotId: string; deltaQuantity: number; reason: string;
  reasonCode: string; unitId: string; authorizedById: string; clientOpId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  if (input.deltaQuantity === 0) throw new ApiError(400, 'Adjustment quantity must be non-zero');
  await requireFacilityInOrg(input.organizationId, input.facilityId);

  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      if (await isDuplicate(input.clientOpId, session)) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');
      const lot = await Lot.findOne({ lotId: input.lotId, organizationId: input.organizationId }).session(session);
      if (!lot) throw new ApiError(404, `Lot ${input.lotId} was not found`);
      if (lot.facilityId !== input.facilityId) throw new ApiError(409, 'Lot is not held at this facility');
      if (lot.currentQuantity + input.deltaQuantity < -1e-9) throw new ApiError(409, 'Adjustment would make stock negative', 'INSUFFICIENT_STOCK');

      const before = lot.currentQuantity;
      lot.currentQuantity = Number((lot.currentQuantity + input.deltaQuantity).toFixed(10));
      lot.status = lot.currentQuantity <= 1e-9 ? 'Withdrawn' : 'PartiallyWithdrawn';
      await lot.save({ session });
      await Movement.create([{
        movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: lot.lotId,
        type: 'Adjust', direction: input.deltaQuantity > 0 ? 'In' : 'Out', quantity: Math.abs(input.deltaQuantity),
        weightKg: 0, packageCount: 0, unitId: input.unitId, reason: input.reason, reasonCode: input.reasonCode,
        authorizedById: input.authorizedById, actorId, clientOpId: input.clientOpId ?? null
      }], { session });
      await GenealogyEvent.create([{
        eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: input.facilityId,
        type: 'Adjust', sourceLotIds: [lot.lotId], targetLotIds: [], quantitiesBefore: { [lot.lotId]: before },
        quantitiesAfter: { [lot.lotId]: lot.currentQuantity }, unitId: input.unitId,
        reason: input.reason, actorId
      }], { session });
      result = lot.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'movements', recordId: input.lotId, action: 'Adjust', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Split                                                               */
/* ------------------------------------------------------------------ */

export async function splitLot(input: {
  organizationId: string; facilityId: string; sourceLotId: string;
  allocations: Array<{ quantity: number; unitId: string; locationId: string; palletId?: string | null; notes?: string }>;
  reason: string; clientOpId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  const totalSplit = input.allocations.reduce((sum, a) => sum + a.quantity, 0);
  if (totalSplit <= 0) throw new ApiError(400, 'Split quantity must be positive');
  await requireFacilityInOrg(input.organizationId, input.facilityId);

  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      if (await isDuplicate(input.clientOpId, session)) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');
      const source = await Lot.findOne({ lotId: input.sourceLotId, organizationId: input.organizationId }).session(session);
      if (!source) throw new ApiError(404, `Lot ${input.sourceLotId} was not found`);
      if (source.facilityId !== input.facilityId) throw new ApiError(409, 'Lot is not held at this facility');
      if (!['Active', 'PartiallyWithdrawn'].includes(source.status)) throw new ApiError(409, `Lot ${source.lotId} is ${source.status}`);
      if (source.currentQuantity + 1e-9 < totalSplit) throw new ApiError(409, `Split exceeds available quantity (${source.currentQuantity})`, 'INSUFFICIENT_STOCK');
      // Lien: pledged stock cannot be split away from the pledged lot.
      assertLienFree(source, totalSplit, 'Split');

      const beforeQty = source.currentQuantity;
      const childIds: string[] = [];
      // create children
      for (const allocation of input.allocations) {
        const location = await StorageLocation.findOne({ locationId: allocation.locationId, facilityId: input.facilityId }).session(session).lean();
        if (!location) throw new ApiError(404, `Storage location ${allocation.locationId} was not found`);
        const childId = await nextId('lot');
        childIds.push(childId);
        await Lot.create([{
          lotId: childId, organizationId: input.organizationId, facilityId: input.facilityId,
          lotNumber: childId, commodityId: source.commodityId, varietyId: source.varietyId, packagingId: source.packagingId,
          quantityUnitId: allocation.unitId, ownerId: source.ownerId, custodianFacilityId: source.custodianFacilityId,
          locationId: allocation.locationId, palletId: allocation.palletId ?? null,
          openingQuantity: allocation.quantity, currentQuantity: allocation.quantity, packageCount: 0,
          isOperatorOwned: source.isOperatorOwned, status: 'Active', notes: `Split from ${source.lotNumber} — ${input.reason}`
        }], { session });
        await Movement.create([{
          movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: childId,
          type: 'SplitInto', direction: 'In', quantity: allocation.quantity, weightKg: 0, packageCount: 0, unitId: allocation.unitId,
          toLocationId: allocation.locationId, toOwnerId: source.ownerId, reason: input.reason, actorId
        }], { session });
        await OwnershipEvent.create([{
          eventId: await nextId('ownershipEvent'), organizationId: input.organizationId, lotId: childId,
          type: 'Split', toOwnerId: source.ownerId, quantity: allocation.quantity, facilityId: input.facilityId, reason: input.reason, actorId
        }], { session });
      }
      // reduce source
      source.currentQuantity = Number((source.currentQuantity - totalSplit).toFixed(10));
      if (source.currentQuantity <= 1e-9) {
        source.currentQuantity = 0;
        source.status = 'Withdrawn';
        source.closedAt = new Date();
      } else {
        source.status = 'PartiallyWithdrawn';
      }
      await source.save({ session });
      await Movement.create([{
        movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: source.lotId,
        type: 'SplitFrom', direction: 'Out', quantity: totalSplit, weightKg: 0, packageCount: 0, unitId: source.quantityUnitId,
        reason: input.reason, actorId
      }], { session });
      await GenealogyEvent.create([{
        eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: input.facilityId,
        type: 'Split', sourceLotIds: [source.lotId], targetLotIds: childIds,
        quantitiesBefore: { [source.lotId]: beforeQty }, quantitiesAfter: { [source.lotId]: source.currentQuantity, ...Object.fromEntries(childIds.map((id, index) => [id, input.allocations[index]?.quantity ?? 0])) },
        unitId: source.quantityUnitId, reason: input.reason, actorId
      }], { session });
      result = { sourceLot: source.toObject(), childLotIds: childIds };
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'lots', recordId: input.sourceLotId, action: 'Split', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

export async function mergeLots(input: {
  organizationId: string; facilityId: string; sourceLotIds: string[]; targetLotId?: string | null;
  targetLocationId: string; unitId: string; reason: string; clientOpId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  if (input.sourceLotIds.length < 2) throw new ApiError(400, 'Merge requires at least two source lots');
  await requireFacilityInOrg(input.organizationId, input.facilityId);

  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      if (await isDuplicate(input.clientOpId, session)) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');
      const lots = await Lot.find({ lotId: { $in: input.sourceLotIds }, organizationId: input.organizationId }).session(session);
      if (lots.length !== input.sourceLotIds.length) throw new ApiError(404, 'One or more source lots were not found');
      const ownerIds = new Set(lots.map((lot) => lot.ownerId));
      if (ownerIds.size > 1) {
        throw new ApiError(409, 'Merge involves multiple owners; explicit ownership allocation is required', 'MULTIPLE_OWNERS');
      }
      const commodityIds = new Set(lots.map((lot) => String(lot.commodityId)));
      if (commodityIds.size > 1) throw new ApiError(409, 'Cannot merge lots of different commodities');
      for (const lot of lots) {
        if (lot.facilityId !== input.facilityId) throw new ApiError(409, `Lot ${lot.lotId} is not held at this facility`);
        if (!['Active', 'PartiallyWithdrawn'].includes(lot.status)) throw new ApiError(409, `Lot ${lot.lotId} has status ${lot.status}`);
        if (lot.currentQuantity <= 0) throw new ApiError(409, `Lot ${lot.lotId} has no stock`);
      }
      // Lien: pledged stock follows the merged lot, so merging pledged lots is allowed as
      // long as no lot is fully pledged to a different loan and everything stays in org.
      const totalLien = lots.reduce((sum, lot) => sum + Number(lot.pledgedQuantity ?? 0), 0);

      const totalQuantity = lots.reduce((sum, lot) => sum + lot.currentQuantity, 0);
      const targetId = input.targetLotId ?? (await nextId('lot'));
      const base = lots[0]!;
      const [merged] = await Lot.create([{
        lotId: targetId, organizationId: input.organizationId, facilityId: input.facilityId, lotNumber: targetId,
        commodityId: base.commodityId, varietyId: base.varietyId, packagingId: base.packagingId,
        quantityUnitId: input.unitId, ownerId: base.ownerId, custodianFacilityId: base.custodianFacilityId,
        locationId: input.targetLocationId, palletId: null,
        openingQuantity: totalQuantity, currentQuantity: totalQuantity,
        pledgedQuantity: totalLien, pledgeStatus: derivePledgeStatus(totalQuantity, totalLien),
        packageCount: lots.reduce((sum, lot) => sum + lot.packageCount, 0),
        isOperatorOwned: base.isOperatorOwned, status: 'Active', notes: `Merged from ${lots.map((l) => l.lotNumber).join(', ')} — ${input.reason}`
      }], { session });

      const quantitiesBefore: Record<string, number> = {};
      for (const lot of lots) {
        quantitiesBefore[lot.lotId] = lot.currentQuantity;
        lot.status = 'Merged';
        lot.closedAt = new Date();
        await lot.save({ session });
        await Movement.create([{
          movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: lot.lotId,
          type: 'MergedFrom', direction: 'Out', quantity: lot.currentQuantity, weightKg: 0, packageCount: lot.packageCount,
          unitId: lot.quantityUnitId, reason: input.reason, actorId
        }], { session });
      }
      await Movement.create([{
        movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: targetId,
        type: 'MergedFrom', direction: 'In', quantity: totalQuantity, weightKg: 0, packageCount: lots.reduce((sum, lot) => sum + lot.packageCount, 0),
        unitId: input.unitId, toLocationId: input.targetLocationId, toOwnerId: base.ownerId, reason: input.reason, actorId
      }], { session });
      await GenealogyEvent.create([{
        eventId: await nextId('genealogy'), organizationId: input.organizationId, facilityId: input.facilityId,
        type: 'Merge', sourceLotIds: lots.map((lot) => lot.lotId), targetLotIds: [targetId],
        quantitiesBefore, quantitiesAfter: { [targetId]: totalQuantity }, unitId: input.unitId, reason: input.reason, actorId
      }], { session });
      result = { mergedLot: merged!.toObject(), sourceLotIds: lots.map((lot) => lot.lotId) };
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'lots', recordId: input.sourceLotIds.join(','), action: 'Merge', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Ownership transfer                                                  */
/* ------------------------------------------------------------------ */

export async function transferOwnership(input: {
  organizationId: string; facilityId: string; lotId: string; toOwnerId: string; reason: string; expectedOwnerId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireInventoryRole(role);
  await requireFacilityInOrg(input.organizationId, input.facilityId);

  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const lot = await Lot.findOne({ lotId: input.lotId, organizationId: input.organizationId }).session(session);
      if (!lot) throw new ApiError(404, `Lot ${input.lotId} was not found`);
      if (lot.status === 'Withdrawn') throw new ApiError(409, `Lot ${lot.lotId} has been withdrawn`);
      if (input.expectedOwnerId && lot.ownerId !== input.expectedOwnerId) throw new ApiError(409, `Lot ${lot.lotId} is not owned by ${input.expectedOwnerId}`, 'OWNER_MISMATCH');
      // A lot under a pledge lien cannot be sold/transferred to another owner while pledged.
      if ((lot.pledgedQuantity ?? 0) > 1e-9) {
        throw new ApiError(409, `Lot ${lot.lotId} has ${lot.pledgedQuantity} units pledged as loan security — ownership cannot change until the pledge is repaid`, 'PLEDGED_LOCK');
      }
      const fromOwner = lot.ownerId;
      if (fromOwner === input.toOwnerId) throw new ApiError(409, 'Lot is already owned by this party');

      lot.ownerId = input.toOwnerId;
      await lot.save({ session });
      await OwnershipEvent.create([{
        eventId: await nextId('ownershipEvent'), organizationId: input.organizationId, lotId: lot.lotId,
        type: 'Transfer', fromOwnerId: fromOwner, toOwnerId: input.toOwnerId, quantity: lot.currentQuantity,
        facilityId: input.facilityId, reason: input.reason, actorId
      }], { session });
      await Movement.create([{
        movementId: await nextId('movement'), organizationId: input.organizationId, facilityId: input.facilityId, lotId: lot.lotId,
        type: 'Adjust', direction: 'In', quantity: lot.currentQuantity, weightKg: 0, packageCount: lot.packageCount,
        unitId: lot.quantityUnitId, fromOwnerId: fromOwner, toOwnerId: input.toOwnerId,
        reason: `Ownership transfer — ${input.reason}`, actorId
      }], { session });
      result = lot.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'lots', recordId: input.lotId, action: 'Transfer Ownership', actorId, metadata: input });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

export async function listLots(input: { organizationId: string; facilityId?: string; ownerId?: string; commodityId?: string; status?: string; lotNumber?: string; search?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  for (const key of ['facilityId', 'ownerId', 'commodityId', 'status'] as const) {
    if (input[key]) filter[key] = input[key];
  }
  if (input.lotNumber) filter.lotNumber = { $regex: input.lotNumber, $options: 'i' };
  if (input.search) filter.$or = [{ lotNumber: { $regex: input.search, $options: 'i' } }, { lotId: { $regex: input.search, $options: 'i' } }];
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Lot.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Lot.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

export async function getLotProfile(lotId: string, organizationId: string): Promise<object> {
  const lot = await Lot.findOne({ lotId, organizationId }).lean();
  if (!lot) throw new ApiError(404, `Lot ${lotId} was not found`);
  const [movements, genealogy, ownershipEvents] = await Promise.all([
    Movement.find({ lotId }).sort({ createdAt: 1 }).lean(),
    GenealogyEvent.find({ $or: [{ sourceLotIds: lotId }, { targetLotIds: lotId }] }).sort({ createdAt: 1 }).lean(),
    OwnershipEvent.find({ lotId }).sort({ createdAt: 1 }).lean()
  ]);
  return { lot, movements, genealogy, ownershipEvents };
}

export async function getLotByNumber(lotNumber: string, organizationId: string): Promise<object | null> {
  return Lot.findOne({ lotNumber, organizationId }).lean();
}
