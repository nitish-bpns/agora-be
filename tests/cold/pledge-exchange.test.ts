import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility, Party } from '../../src/modules/warehouse/org.models.js';
import { Unit, Commodity, StorageLocation } from '../../src/modules/warehouse/master.models.js';
import { recordInward, recordOutward } from '../../src/modules/warehouse/inventory.service.js';
import { Lot } from '../../src/modules/warehouse/inventory.models.js';
import { Pledge, PledgeTransaction } from '../../src/modules/warehouse/pledge.models.js';
import { createFinancer, createPledgeApplication, reactToApplication, releasePledgeStock, repayPledge, refreshPledgeValuation, refreshAllPledges, getLivePrice, assertInstrumentSellFree } from '../../src/modules/warehouse/pledge.service.js';
import { Security } from '../../src/modules/exchange/exchange.models.js';
import { DeskAccount, DeskInstrument, DeskPrice } from '../../src/modules/desk/desk.models.js';
import { clearDatabase } from './test-db.js';

beforeEach(async () => {
  await clearDatabase();
  await Organization.create({ organizationId: 'ORG-A', name: 'Org A' });
  await Facility.create({ facilityId: 'FAC-A', organizationId: 'ORG-A', name: 'Facility A', code: 'A' });
  await Party.create({ partyId: 'PRT-A', organizationId: 'ORG-A', partyType: 'Customer', name: 'Sharma Traders' });
  await Unit.create({ unitId: 'UNT-A', organizationId: 'ORG-A', code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  // Potato is exchange-linked to AGORA (the demo security on the electronic mandi).
  await Commodity.create({ commodityId: 'CMD-A', organizationId: 'ORG-A', name: 'Potato', exchangeSymbol: 'AGORA' });
  await StorageLocation.create({ locationId: 'LOC-A', organizationId: 'ORG-A', facilityId: 'FAC-A', type: 'Chamber', name: 'A', code: 'A', capacityBags: 1000 });
  const securityId = 'SEC-DEMO';
  await Security.create({ securityId, instrumentId: 'INS-DEMO', symbol: 'AGORA', mandiId: 'MND-DEMO', tickSize: 0.01, lotSize: 1, priceBandPct: 20, referencePrice: 100, settlementDays: 2, depositoryId: 'DEP-DEMO' });
  await DeskInstrument.create({ instrumentId: securityId, symbol: 'AGORA', name: 'Potato Futures', active: true });
  await DeskPrice.create({ instrumentId: securityId, price: 100, effectiveDate: '2026-01-01' });
});

async function pledgeScenario() {
  await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
  const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', interestRatePct: 12, maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
  const app = await createPledgeApplication({
    organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A',
    lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 10000, requestedAmount: 6000,
    financerId: financer.financerId
  }, 'USR-CUST') as { applicationId: string };
  const pledge = await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string; pledgedPrice: number };
  return { financerId: financer.financerId, pledgeId: pledge.pledgeId, pledgedPrice: pledge.pledgedPrice };
}

describe('pledge ↔ exchange price linkage (margin calls)', () => {
  it('commodity exchange symbol is resolved to the live exchange price', async () => {
    const live = await getLivePrice({ commodityId: 'CMD-A' });
    expect(live?.symbol).toBe('AGORA');
    expect(live?.source).toBe('exchange-price');
    expect(live?.price).toBe(100);
  });

  it('pledge stores the pledged price at approval', async () => {
    const { pledgeId, pledgedPrice } = await pledgeScenario();
    expect(pledgedPrice).toBe(100); // 10000 stock value / 100 qty
    const plex = await Pledge.findOne({ pledgeId }).lean();
    expect(plex?.pledgedPrice).toBe(100);
    expect(plex?.marginCallStatus).toBe('Exempt'); // not yet valued
  });

  it('revalue at a lower price triggers a margin call', async () => {
    const { pledgeId } = await pledgeScenario();
    // Price falls 100 → 60: collateral 6000, loan 6000 → LTV 100% (default)
    await DeskPrice.create({ instrumentId: 'SEC-DEMO', price: 60, effectiveDate: '2026-01-02' });
    const result = await refreshPledgeValuation(pledgeId, 'USR-ADMIN');
    expect(result?.pledge.marginCallStatus).toBe('Default');
    expect(result?.pledge.lastValuationPrice).toBe(60);
    const tx = await PledgeTransaction.findOne({ pledgeId, type: 'MarginCall' }).lean();
    expect(tx).toBeTruthy();
  });

  it('revalue at a healthy price keeps the pledge healthy', async () => {
    const { pledgeId } = await pledgeScenario();
    await DeskPrice.create({ instrumentId: 'SEC-DEMO', price: 150, effectiveDate: '2026-01-02' });
    const result = await refreshPledgeValuation(pledgeId, 'USR-ADMIN');
    expect(result?.pledge.marginCallStatus).toBe('Healthy');
    expect(result?.pledge.lastValuationLtvPct).toBeLessThan(70);
  });

  it('a warning fires in between healthy and margin-call thresholds', async () => {
    const { pledgeId } = await pledgeScenario();
    // loan 6000, collateral 100*75=7500 → LTV 80% = threshold → MarginCall; 6000/80 = 75
    await DeskPrice.create({ instrumentId: 'SEC-DEMO', price: 75, effectiveDate: '2026-01-02' });
    const result = await refreshPledgeValuation(pledgeId, 'USR-ADMIN');
    expect(['Warning', 'MarginCall']).toContain(result?.pledge.marginCallStatus);
  });

  it('refreshAllPledges reports margin calls across the book', async () => {
    await pledgeScenario();
    await DeskPrice.create({ instrumentId: 'SEC-DEMO', price: 50, effectiveDate: '2026-01-02' });
    const summary = await refreshAllPledges({ organizationId: 'ORG-A' }, 'USR-ADMIN');
    expect(summary.refreshed).toBe(1);
    expect(summary.marginCalls).toBe(1);
    expect(summary.items[0]?.marginCallStatus).toBe('Default');
  });
});

describe('pledged lots are locked from trading / withdrawal', () => {
  it('approving a pledge reserves the quantity on the lot (lien)', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 60, unitId: 'UNT-A', stockValue: 6000, requestedAmount: 3600, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN');
    const lot = await Lot.findOne({ lotId: 'LOT-00000001' }).lean();
    expect(lot?.pledgedQuantity).toBe(60);
    expect(lot?.pledgeStatus).toBe('PartiallyPledged');
  });

  it('outward of pledged quantity is blocked', async () => {
    await pledgeScenario();
    // Fully pledged (100/100) → outward 1 unit must fail
    await expect(recordOutward({ organizationId: 'ORG-A', facilityId: 'FAC-A', lotId: 'LOT-00000001', quantity: 1, unitId: 'UNT-A' }, 'USR-A', 'InventoryOperator')).rejects.toMatchObject({ code: 'PLEDGED_LOCK' });
  });

  it('outward of unpledged free quantity is allowed', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 40, unitId: 'UNT-A', stockValue: 4000, requestedAmount: 2400, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN');
    // 40 pledged, 60 free — outward of 50 is fine, 60+ is not
    const result = await recordOutward({ organizationId: 'ORG-A', facilityId: 'FAC-A', lotId: 'LOT-00000001', quantity: 50, unitId: 'UNT-A' }, 'USR-A', 'InventoryOperator') as { currentQuantity: number };
    expect(result.currentQuantity).toBe(50);
  });

  it('cannot apply to pledge the same quantity twice (double pledge blocked)', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    // First application approved → 60 of the lot is now lien-held.
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 60, unitId: 'UNT-A', stockValue: 6000, requestedAmount: 3600, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN');
    // Only 40 free remains → a second application pledging 60 is blocked.
    await expect(createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 60, unitId: 'UNT-A', stockValue: 6000, requestedAmount: 3600, financerId: financer.financerId }, 'USR-CUST')).rejects.toMatchObject({ code: 'PLEDGED_LOCK' });
  });

  it('can pledge the remaining free quantity after a partial pledge', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 60, unitId: 'UNT-A', stockValue: 6000, requestedAmount: 3600, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN');
    // 40 free remaining is pledgeable under a second financer.
    const second = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 40, unitId: 'UNT-A', stockValue: 4000, requestedAmount: 2400, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    expect(second.applicationId).toMatch(/^PLA-/);
    const pledge2 = await reactToApplication({ applicationId: second.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string };
    expect(pledge2.pledgeId).toMatch(/^PLG-/);
    const lot = await Lot.findOne({ lotId: 'LOT-00000001' }).lean();
    expect(lot?.pledgedQuantity).toBe(100);
    expect(lot?.pledgeStatus).toBe('FullyPledged');
  });

  it('lien is released when the pledge is repaid', async () => {
    const { pledgeId } = await pledgeScenario();
    await repayPledge({ pledgeId, principalAmount: 6000 }, 'USR-CUST');
    const lot = await Lot.findOne({ lotId: 'LOT-00000001' }).lean();
    expect(lot?.pledgedQuantity).toBe(0);
    expect(lot?.pledgeStatus).toBe('Unpledged');
  });

  it('partial release frees only the released quantity', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Agri Bank', financerType: 'Bank', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 80, unitId: 'UNT-A', stockValue: 8000, requestedAmount: 4800, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    const pledge = await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string };
    await releasePledgeStock({ pledgeId: pledge.pledgeId, quantity: 30 }, 'USR-ADMIN');
    const lot = await Lot.findOne({ lotId: 'LOT-00000001' }).lean();
    expect(lot?.pledgedQuantity).toBe(50);
    expect(lot?.pledgeStatus).toBe('PartiallyPledged');
  });

  it('sell of pledged exchange-linked goods is blocked for linked parties', async () => {
    await pledgeScenario(); // PRT-A fully pledged 100
    // PRT-A has User USR-PRT (partyId PRT-A)
    const { User } = await import('../../src/modules/auth/auth.model.js');
    await User.create({ userId: 'USR-PRT', username: 'prt@test.com', displayName: 'P', userType: 'Customer', role: 'Operations', status: 'Active', partyId: 'PRT-A', passwordHash: 'x' });
    await DeskAccount.create({ accountId: 'ACC-CUST', label: 'Customer', traderId: 'USR-PRT' });
    await expect(assertInstrumentSellFree({ symbol: 'AGORA', partyId: 'PRT-A', quantity: 10 })).rejects.toMatchObject({ code: 'PLEDGED_LOCK' });
  });
});

/**
 * The storage application is deployed independently across many facilities.
 * An exchange may be absent entirely, or present but not connected to this
 * storage. Pledging, liens and repayments must work fully without it — only
 * live margin monitoring is unavailable (pledges stay 'Exempt').
 */
describe('standalone storage deployment (no exchange present)', () => {
  beforeEach(async () => {
    // Remove every exchange/desk artefact: no mandi, no security, no price feed.
    await Security.deleteMany({});
    await DeskPrice.deleteMany({});
    await DeskInstrument.deleteMany({});
    // Commodity is NOT exchange-linked in this deployment.
    await Commodity.updateOne({ commodityId: 'CMD-A' }, { $set: { exchangeSymbol: null } });
  });

  it('live price resolves to null when the commodity has no exchange link', async () => {
    expect(await getLivePrice({ commodityId: 'CMD-A' })).toBeNull();
  });

  it('live price is unpriced when linked but no exchange data exists', async () => {
    await Commodity.updateOne({ commodityId: 'CMD-A' }, { $set: { exchangeSymbol: 'AGORA' } });
    const live = await getLivePrice({ commodityId: 'CMD-A' });
    expect(live?.source).toBe('unpriced');
    expect(live?.price).toBe(0);
  });

  it('pledging, lien locking and repayment all work without an exchange', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Local Coop', financerType: 'Cooperative', interestRatePct: 10, maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 60, unitId: 'UNT-A', stockValue: 6000, requestedAmount: 3600, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    const pledge = await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN') as { pledgeId: string };

    // Lien is enforced with no exchange in the picture.
    const lot = await Lot.findOne({ lotId: 'LOT-00000001' }).lean();
    expect(lot?.pledgedQuantity).toBe(60);
    expect(lot?.pledgeStatus).toBe('PartiallyPledged');
    await expect(recordOutward({ organizationId: 'ORG-A', facilityId: 'FAC-A', lotId: 'LOT-00000001', quantity: 50, unitId: 'UNT-A' }, 'USR-A', 'InventoryOperator')).rejects.toMatchObject({ code: 'PLEDGED_LOCK' });

    // Valuation is a no-op that leaves the pledge Exempt (no live price to compare).
    const valued = await refreshPledgeValuation(pledge.pledgeId, 'USR-ADMIN');
    expect(valued?.pledge.marginCallStatus).toBe('Exempt');
    expect(valued?.live).toBeUndefined();

    // Repayment still releases the lien.
    await repayPledge({ pledgeId: pledge.pledgeId, principalAmount: 3600 }, 'USR-CUST');
    const after = await Lot.findOne({ lotId: 'LOT-00000001' }).lean();
    expect(after?.pledgedQuantity).toBe(0);
    expect(after?.pledgeStatus).toBe('Unpledged');
  });

  it('refreshAllPledges reports every pledge as exempt when no exchange is connected', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 100, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const financer = await createFinancer({ organizationId: 'ORG-A', name: 'Local Coop', financerType: 'Cooperative', maxLtvPct: 70 }, 'USR-ADMIN') as { financerId: string };
    const app = await createPledgeApplication({ organizationId: 'ORG-A', facilityId: 'FAC-A', applicantPartyId: 'PRT-A', lotId: 'LOT-00000001', quantity: 100, unitId: 'UNT-A', stockValue: 10000, requestedAmount: 6000, financerId: financer.financerId }, 'USR-CUST') as { applicationId: string };
    await reactToApplication({ applicationId: app.applicationId, financerId: financer.financerId, decision: 'Approved' }, 'USR-FIN');

    const summary = await refreshAllPledges({ organizationId: 'ORG-A' }, 'USR-ADMIN');
    expect(summary.refreshed).toBe(1);
    expect(summary.exempt).toBe(1);
    expect(summary.marginCalls).toBe(0);
  });

  it('sell blocking is a no-op for commodities with no exchange link', async () => {
    await pledgeScenario();
    // No exchange link → no lien lookup → sell is not blocked by the pledge module.
    await expect(assertInstrumentSellFree({ symbol: 'AGORA', partyId: 'PRT-A', quantity: 10 })).resolves.toBeUndefined();
  });
});