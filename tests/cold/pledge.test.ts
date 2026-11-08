import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility, Party } from '../../src/modules/warehouse/org.models.js';
import { Unit, Commodity, StorageLocation } from '../../src/modules/warehouse/master.models.js';
import { recordInward } from '../../src/modules/warehouse/inventory.service.js';
import { PledgeTransaction } from '../../src/modules/warehouse/pledge.models.js';
import { createFinancer, createPledgeApplication, reactToApplication, listPledges, repayPledge, releasePledgeStock } from '../../src/modules/warehouse/pledge.service.js';
import { clearDatabase } from './test-db.js';

beforeEach(async () => {
  await clearDatabase();
  await Organization.create({ organizationId: 'ORG-A', name: 'Org A' });
  await Facility.create({ facilityId: 'FAC-A', organizationId: 'ORG-A', name: 'Facility A', code: 'A' });
  await Party.create({ partyId: 'PRT-A', organizationId: 'ORG-A', partyType: 'Customer', name: 'Sharma Traders' });
  await Unit.create({ unitId: 'UNT-A', organizationId: 'ORG-A', code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  await Commodity.create({ commodityId: 'CMD-A', organizationId: 'ORG-A', name: 'Potato' });
  await StorageLocation.create({ locationId: 'LOC-A', organizationId: 'ORG-A', facilityId: 'FAC-A', type: 'Chamber', name: 'A', code: 'A', capacityBags: 1000 });
});

describe('stock pledging', () => {
  it('central admin creates a financer with lending policy', async () => {
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', interestRatePct: 12, maxLtvPct: 70, tenureMonths: 12 }, 'USR-ADMIN') as { financerId: string; maxLtvPct: number };
    expect(financer.financerId).toMatch(/^FIN-/);
    expect(financer.maxLtvPct).toBe(70);
  });

  it('customer pledges their lot and financer approves (creates pledge)', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', interestRatePct: 12, maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({
      organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A',
      lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 50000, requestedAmount: 30000,
      financerId: financer.financerId, requestedTenureMonths: 12, purpose: 'Working capital'
    }, 'USR-CUST') as { applicationId: string };
    expect(app.applicationId).toMatch(/^PLA-/);
    const pledge = await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string; loanAmount: number; status: string };
    expect(pledge.pledgeId).toMatch(/^PLG-/);
    expect(pledge.loanAmount).toBe(30000);
    expect(pledge.status).toBe('Active');
    const list = await listPledges({ financerId: financer.financerId }) as { items: Array<{ pledgeId: string }> };
    expect(list.items).toHaveLength(1);
  });

  it('cannot pledge more than owned stock', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 10, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    await expect(createPledgeApplication({
      organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A',
      lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 50000, requestedAmount: 30000
    }, 'USR-CUST')).rejects.toThrow('exceeds available stock');
  });

  it('non-owner cannot pledge a lot', async () => {
    await Party.create({ partyId: 'PRT-B', organizationId: 'ORG-A', partyType: 'Customer', name: 'Other' });
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 10, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    await expect(createPledgeApplication({
      organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-B',
      lotId: 'LOT-00000001', quantity: 10, unitId: 'UNT-A', stockValue: 5000, requestedAmount: 3000
    }, 'USR-B')).rejects.toThrow('can only pledge lots you own');
  });

  it('LTV cap is enforced on approval', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', interestRatePct: 12, maxLtvPct: 50 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({
      organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A',
      lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 100000, requestedAmount: 80000,
      financerId: financer.financerId
    }, 'USR-CUST') as { applicationId: string };
    await expect(reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN')).rejects.toThrow('LTV');
  });

  it('full repayment closes the pledge with ledger entries', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({
      organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A',
      lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 50000, requestedAmount: 30000,
      financerId: financer.financerId
    }, 'USR-CUST') as { applicationId: string };
    const pledge = await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string };
    const repaid = await repayPledge({ pledgeId: pledge.pledgeId, principalAmount: 30000 }, 'USR-CUST') as { status: string };
    expect(repaid.status).toBe('Closed');
    const txCount = await PledgeTransaction.countDocuments({ pledgeId: pledge.pledgeId });
    expect(txCount).toBeGreaterThanOrEqual(3); // disbursement + principal + closure
  });

  it('release increases released quantity', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({
      organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A',
      lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 50000, requestedAmount: 30000,
      financerId: financer.financerId
    }, 'USR-CUST') as { applicationId: string };
    const pledge = await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string };
    const released = await releasePledgeStock({ pledgeId: pledge.pledgeId, quantity: 40 }, 'USR-ADMIN') as { releasedQuantity: number; status: string };
    expect(released.releasedQuantity).toBe(40);
    expect(released.status).toBe('PartiallyReleased');
  });
});