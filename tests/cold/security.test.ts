import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility, Party, FacilityUser } from '../../src/modules/warehouse/org.models.js';
import { Unit, Commodity, StorageLocation } from '../../src/modules/warehouse/master.models.js';
import { recordInward, listLots } from '../../src/modules/warehouse/inventory.service.js';
import { resolveColdAccess } from '../../src/modules/warehouse/context.js';
import { clearDatabase } from './test-db.js';

beforeEach(async () => {
  await clearDatabase();
  await Organization.create([{ organizationId: 'ORG-A', name: 'Org A' }, { organizationId: 'ORG-B', name: 'Org B' }]);
  await Facility.create([{ facilityId: 'FAC-A', organizationId: 'ORG-A', name: 'Facility A', code: 'A' }, { facilityId: 'FAC-B', organizationId: 'ORG-B', name: 'Facility B', code: 'B' }]);
  await Party.create({ partyId: 'PRT-A', organizationId: 'ORG-A', partyType: 'Customer', name: 'A' });
  await Unit.create({ unitId: 'UNT-A', organizationId: 'ORG-A', code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  await Commodity.create({ commodityId: 'CMD-A', organizationId: 'ORG-A', name: 'Potato' });
  await StorageLocation.create({ locationId: 'LOC-A', organizationId: 'ORG-A', facilityId: 'FAC-A', type: 'Chamber', name: 'A', code: 'A', capacityBags: 1000 });
});

describe('facility isolation & RBAC', () => {
  it('resolveColdAccess honors facility assignment and picks the strongest role', async () => {
    await FacilityUser.create({ facilityUserId: 'FCU-1', organizationId: 'ORG-A', facilityId: 'FAC-A', userId: 'USR-1', role: 'InventoryOperator' });
    await FacilityUser.create({ facilityUserId: 'FCU-2', organizationId: 'ORG-A', facilityId: 'FAC-A', userId: 'USR-1', role: 'FacilityManager' });
    const access = await resolveColdAccess({ userId: 'USR-1', facilityId: 'FAC-A' });
    expect(access.role).toBe('FacilityManager');
    expect(access.facilityId).toBe('FAC-A');
  });

  it('throws for users with no cold access', async () => {
    await expect(resolveColdAccess({ userId: 'USR-NO' })).rejects.toThrow('no cold-storage facility access');
  });

  it('a user in org A cannot record inward into org B facility', async () => {
    await FacilityUser.create({ facilityUserId: 'FCU-A', organizationId: 'ORG-A', facilityId: 'FAC-A', userId: 'USR-A', role: 'InventoryOperator' });
    await expect(recordInward({
      organizationId: 'ORG-A', facilityId: 'FAC-B', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 10, ownerId: 'PRT-A', locationId: 'LOC-A'
    }, 'USR-A', 'InventoryOperator')).rejects.toThrow('Facility was not found in this organization');
  });

  it('lot lists are scoped to the caller organization', async () => {
    await FacilityUser.create({ facilityUserId: 'FCU-A', organizationId: 'ORG-A', facilityId: 'FAC-A', userId: 'USR-A', role: 'InventoryOperator' });
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 10, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const resultA = await listLots({ organizationId: 'ORG-A' });
    expect((resultA as { items: unknown[] }).items).toHaveLength(1);
    const resultB = await listLots({ organizationId: 'ORG-B' });
    expect((resultB as { items: unknown[] }).items).toHaveLength(0);
  });

  it('auditor role cannot write inventory', async () => {
    await FacilityUser.create({ facilityUserId: 'FCU-AUD', organizationId: 'ORG-A', facilityId: 'FAC-A', userId: 'USR-AUD', role: 'Auditor' });
    await expect(recordInward({
      organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 1, ownerId: 'PRT-A', locationId: 'LOC-A'
    }, 'USR-AUD', 'Auditor')).rejects.toThrow('inventory-role');
  });
});
