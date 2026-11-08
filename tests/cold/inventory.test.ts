import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility, Party, FacilityUser } from '../../src/modules/warehouse/org.models.js';
import { Unit, Commodity, StorageLocation, Account } from '../../src/modules/warehouse/master.models.js';
import { Lot, Movement, GenealogyEvent, OwnershipEvent } from '../../src/modules/warehouse/inventory.models.js';
import { recordInward, recordOutward, splitLot, mergeLots, transferOwnership, adjustLot, relocateLot, listLots, getLotProfile } from '../../src/modules/warehouse/inventory.service.js';
import { clearDatabase } from './test-db.js';

const orgId = 'ORG-T1';
const facilityId = 'FAC-T1';
const locationId = 'LOC-T1';
const locationId2 = 'LOC-T2';
const customerId = 'PRT-T1';
const customerId2 = 'PRT-T2';
const commodityId = 'CMD-T1';
const unitId = 'UNT-T1';
const OPERATOR = 'USR-T1';
const MGR = 'USR-T2';

async function seed(): Promise<void> {
  await Organization.create({ organizationId: orgId, name: 'Org' });
  await Facility.create({ facilityId, organizationId: orgId, name: 'Facility', code: 'F1' });
  await Party.create({ partyId: customerId, organizationId: orgId, partyType: 'Customer', name: 'C1' });
  await Party.create({ partyId: customerId2, organizationId: orgId, partyType: 'Customer', name: 'C2' });
  await Unit.create({ unitId, organizationId: orgId, code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  await Commodity.create({ commodityId, organizationId: orgId, name: 'Potato' });
  await StorageLocation.create({ locationId, organizationId: orgId, facilityId, type: 'Chamber', name: 'A', code: 'A', capacityBags: 1000, capacityKg: 50000 });
  await StorageLocation.create({ locationId: locationId2, organizationId: orgId, facilityId, type: 'Chamber', name: 'B', code: 'B', capacityBags: 1000, capacityKg: 50000 });
  await Account.create({ accountId: 'ACT-T1', organizationId: orgId, code: 'AR', name: 'AR', accountType: 'Asset' });
  await FacilityUser.create({ facilityUserId: 'FCU-T1', organizationId: orgId, facilityId, userId: OPERATOR, role: 'InventoryOperator' });
  await FacilityUser.create({ facilityUserId: 'FCU-T2', organizationId: orgId, facilityId, userId: MGR, role: 'FacilityManager' });
}

beforeEach(async () => {
  await clearDatabase();
  await seed();
});

describe('inventory ledger', () => {
  it('inward creates a lot and an auditable movement/genealogy/ownership trail', async () => {
    const result = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 100, weightKg: 5000, packageCount: 0, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const lotId = String((result as { lotId: string }).lotId);
    const lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.currentQuantity).toBe(100);
    expect(lot?.status).toBe('Active');
    expect(await Movement.countDocuments({ lotId })).toBe(1);
    expect(await GenealogyEvent.countDocuments({ targetLotIds: lotId })).toBe(1);
    expect(await OwnershipEvent.countDocuments({ lotId })).toBe(1);
  });

  it('outward reduces stock and full withdrawal closes the lot', async () => {
    const inward = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 100, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const lotId = String((inward as { lotId: string }).lotId);
    await recordOutward({ organizationId: orgId, facilityId, lotId, quantity: 40, unitId }, OPERATOR, 'InventoryOperator');
    let lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.currentQuantity).toBe(60);
    expect(lot?.status).toBe('PartiallyWithdrawn');
    await recordOutward({ organizationId: orgId, facilityId, lotId, quantity: 60, unitId }, OPERATOR, 'InventoryOperator');
    lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.currentQuantity).toBe(0);
    expect(lot?.status).toBe('Withdrawn');
    expect(lot?.closedAt).toBeTruthy();
  });

  it('rejects overselling and leaves stock unchanged', async () => {
    const inward = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 10, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const lotId = String((inward as { lotId: string }).lotId);
    await expect(recordOutward({ organizationId: orgId, facilityId, lotId, quantity: 11, unitId }, OPERATOR, 'InventoryOperator')).rejects.toThrow('Insufficient stock');
    const lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.currentQuantity).toBe(10);
  });

  it('split preserves lineage and reconciles quantities', async () => {
    const inward = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 100, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const sourceLotId = String((inward as { lotId: string }).lotId);
    const result = await splitLot({
      organizationId: orgId, facilityId, sourceLotId,
      allocations: [{ quantity: 30, unitId, locationId }, { quantity: 20, unitId, locationId: locationId2 }],
      reason: 'Customer request'
    }, OPERATOR, 'InventoryOperator');
    const childIds = (result as { childLotIds: string[] }).childLotIds;
    expect(childIds).toHaveLength(2);
    const source = await Lot.findOne({ lotId: sourceLotId }).lean();
    expect(source?.currentQuantity).toBe(50);
    expect(source?.status).toBe('PartiallyWithdrawn');
    const children = await Lot.find({ lotId: { $in: childIds } }).lean();
    const childrenTotal = children.reduce((sum, lot) => sum + lot.currentQuantity, 0);
    expect(childrenTotal).toBe(50);
    const genealogy = await GenealogyEvent.findOne({ type: 'Split', sourceLotIds: sourceLotId }).lean();
    expect(genealogy?.targetLotIds).toHaveLength(2);
    expect(genealogy?.quantitiesBefore[sourceLotId]).toBe(100);
    expect(genealogy?.quantitiesAfter[sourceLotId]).toBe(50);
  });

  it('merge preserves source history and creates a merged lot with combined quantity', async () => {
    const a = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 40, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const b = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 60, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const aId = String((a as { lotId: string }).lotId);
    const bId = String((b as { lotId: string }).lotId);
    const result = await mergeLots({ organizationId: orgId, facilityId, sourceLotIds: [aId, bId], targetLocationId: locationId, unitId, reason: 'Consolidation' }, OPERATOR, 'InventoryOperator');
    const mergedId = String((result as { mergedLot: { lotId: string } }).mergedLot.lotId);
    const merged = await Lot.findOne({ lotId: mergedId }).lean();
    expect(merged?.currentQuantity).toBe(100);
    const sources = await Lot.find({ lotId: { $in: [aId, bId] } }).lean();
    for (const source of sources) expect(source.status).toBe('Merged');
    const genealogy = await GenealogyEvent.findOne({ type: 'Merge' }).lean();
    expect(genealogy?.sourceLotIds).toHaveLength(2);
    expect(genealogy?.targetLotIds).toEqual([mergedId]);
  });

  it('rejects merging lots owned by different parties', async () => {
    const a = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 40, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const b = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 60, ownerId: customerId2, locationId }, OPERATOR, 'InventoryOperator');
    const aId = String((a as { lotId: string }).lotId);
    const bId = String((b as { lotId: string }).lotId);
    await expect(mergeLots({ organizationId: orgId, facilityId, sourceLotIds: [aId, bId], targetLocationId: locationId, unitId, reason: 'Consolidation' }, OPERATOR, 'InventoryOperator')).rejects.toThrow('multiple owners');
  });

  it('ownership transfer keeps history', async () => {
    const inward = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 100, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const lotId = String((inward as { lotId: string }).lotId);
    await transferOwnership({ organizationId: orgId, facilityId, lotId, toOwnerId: customerId2, reason: 'Sale' }, OPERATOR, 'InventoryOperator');
    const lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.ownerId).toBe(customerId2);
    const history = await OwnershipEvent.find({ lotId }).sort({ createdAt: 1 }).lean();
    expect(history).toHaveLength(2);
    expect(history[0]?.toOwnerId).toBe(customerId);
    expect(history[1]?.toOwnerId).toBe(customerId2);
    const profile = await getLotProfile(lotId, orgId);
    expect((profile as { ownershipEvents: unknown[] }).ownershipEvents).toHaveLength(2);
    expect((profile as { movements: unknown[] }).movements.length).toBeGreaterThan(0);
  });

  it('adjustment is auditable and requires authorization', async () => {
    const inward = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 100, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const lotId = String((inward as { lotId: string }).lotId);
    await adjustLot({ organizationId: orgId, facilityId, lotId, deltaQuantity: -5, reason: 'Shrinkage', reasonCode: 'SHRINK', unitId, authorizedById: MGR }, OPERATOR, 'InventoryOperator');
    const lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.currentQuantity).toBe(95);
    const movements = await Movement.find({ lotId, type: 'Adjust' }).lean();
    expect(movements).toHaveLength(1);
    expect(movements[0]?.authorizedById).toBe(MGR);
  });

  it('idempotency: same clientOpId does not double-record inward', async () => {
    const input = { organizationId: orgId, facilityId, commodityId, unitId, quantity: 50, ownerId: customerId, locationId, clientOpId: 'op-1' };
    await recordInward(input, OPERATOR, 'InventoryOperator');
    await expect(recordInward(input, OPERATOR, 'InventoryOperator')).rejects.toThrow('already recorded');
    expect(await Lot.countDocuments({ organizationId: orgId })).toBe(1);
  });

  it('relocate updates the lot location', async () => {
    const inward = await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 50, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const lotId = String((inward as { lotId: string }).lotId);
    await relocateLot({ organizationId: orgId, facilityId, lotId, toLocationId: locationId2, reason: 'Better airflow' }, OPERATOR, 'InventoryOperator');
    const lot = await Lot.findOne({ lotId }).lean();
    expect(lot?.locationId).toBe(locationId2);
    expect(await Movement.countDocuments({ lotId, type: 'Relocate' })).toBe(1);
  });

  it('rejects writes by non-inventory roles', async () => {
    await expect(recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 1, ownerId: customerId, locationId }, 'USR-AUDIT', 'Auditor')).rejects.toThrow('inventory-role');
  });

  it('lists lots filtered by facility and owner', async () => {
    await recordInward({ organizationId: orgId, facilityId, commodityId, unitId, quantity: 30, ownerId: customerId, locationId }, OPERATOR, 'InventoryOperator');
    const result = await listLots({ organizationId: orgId, facilityId, ownerId: customerId });
    expect((result as { items: unknown[] }).items).toHaveLength(1);
  });
});
