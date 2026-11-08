import { beforeEach, describe, expect, it } from 'vitest';
import { Counter } from '../../src/common/models.js';
import { Organization, Facility, Party, FacilityUser } from '../../src/modules/warehouse/org.models.js';
import { Unit, Commodity, StorageLocation, Account } from '../../src/modules/warehouse/master.models.js';
import { clearDatabase } from './test-db.js';

const orgId = 'ORG-00000001';
const facilityId = 'FAC-00000001';
const locationId = 'LOC-00000001';
const customerId = 'PRT-00000001';
const commodityId = 'CMD-00000001';
const unitIdUnit = 'UNT-00000001';
const unitIdKg = 'UNT-00000002';

async function seedBasics(): Promise<void> {
  await Organization.create({ organizationId: orgId, name: 'Test Org' });
  await Facility.create({ facilityId, organizationId: orgId, name: 'Test Facility', code: 'TF1' });
  await Party.create({ partyId: customerId, organizationId: orgId, partyType: 'Customer', name: 'Test Customer' });
  await Unit.create({ unitId: unitIdUnit, organizationId: orgId, code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  await Unit.create({ unitId: unitIdKg, organizationId: orgId, code: 'KG', name: 'Kilogram', category: 'Weight', baseWeightKg: 1 });
  await Commodity.create({ commodityId, organizationId: orgId, name: 'Potato' });
  await StorageLocation.create({ locationId, organizationId: orgId, facilityId, type: 'Chamber', name: 'Chamber A', code: 'CH-A', capacityBags: 1000, capacityKg: 50000, capacityModel: 'Bags' });
  await Account.create({ accountId: 'ACT-00000001', organizationId: orgId, code: 'AR', name: 'Accounts Receivable', accountType: 'Asset', isDefault: true });
  await Account.create({ accountId: 'ACT-00000002', organizationId: orgId, code: 'CASH', name: 'Cash', accountType: 'Asset', isDefault: true });
  await Account.create({ accountId: 'ACT-00000003', organizationId: orgId, code: 'INC-STORAGE', name: 'Storage Income', accountType: 'Income', isDefault: true });
  await Account.create({ accountId: 'ACT-00000004', organizationId: orgId, code: 'LIAB-GST', name: 'GST Payable (Output)', accountType: 'Liability', isDefault: true });
  await Account.create({ accountId: 'ACT-00000005', organizationId: orgId, code: 'INC-DISCOUNT', name: 'Discounts Allowed', accountType: 'Expense', isDefault: true });
  await FacilityUser.create({ facilityUserId: 'FCU-00000001', organizationId: orgId, facilityId, userId: 'USR-00000001', role: 'InventoryOperator' });
  await FacilityUser.create({ facilityUserId: 'FCU-00000002', organizationId: orgId, facilityId, userId: 'USR-00000002', role: 'AccountsOperator' });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBasics();
});

describe('cold storage test database', () => {
  it('connects in-memory and seeds', async () => {
    expect(await Counter.countDocuments({})).toBe(0);
    expect(await Organization.countDocuments({})).toBe(1);
    expect(await Facility.countDocuments({})).toBe(1);
  });
});
