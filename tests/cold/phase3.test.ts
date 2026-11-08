import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility, Party } from '../../src/modules/warehouse/org.models.js';
import { Unit, Commodity, StorageLocation } from '../../src/modules/warehouse/master.models.js';
import { recordInward } from '../../src/modules/warehouse/inventory.service.js';
import { customerStock, customerFinance, customerLoadingEvents } from '../../src/modules/warehouse/customer.service.js';
import { employeeEnvironment, employeeToday, employeeYesterday } from '../../src/modules/warehouse/employee.service.js';
import { generateCashFlow, partyLedger, dayBook, gstSummary, consolidatedStatements, generateFinancialStatements, ensureDefaultAccounts } from '../../src/modules/warehouse/finance.service.js';
import { clearDatabase } from './test-db.js';

beforeEach(async () => {
  await clearDatabase();
  await Organization.create([{ organizationId: 'ORG-A', name: 'Org A' }]);
  await Facility.create({ facilityId: 'FAC-A', organizationId: 'ORG-A', name: 'Facility A', code: 'A' });
  await Party.create({ partyId: 'PRT-A', organizationId: 'ORG-A', partyType: 'Customer', name: 'Sharma Traders' });
  await Unit.create({ unitId: 'UNT-A', organizationId: 'ORG-A', code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  await Commodity.create({ commodityId: 'CMD-A', organizationId: 'ORG-A', name: 'Potato' });
  await StorageLocation.create({ locationId: 'LOC-A', organizationId: 'ORG-A', facilityId: 'FAC-A', type: 'Chamber', name: 'A', code: 'A', capacityBags: 1000 });
});

describe('customer terminal', () => {
  it('lists the customer stock with facility names', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 10, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const stock = await customerStock('PRT-A') as { totalLots: number; totalQuantity: number; lots: Array<{ facilityName: string; lotNumber: string }> };
    expect(stock.totalLots).toBe(1);
    expect(stock.totalQuantity).toBe(10);
    expect(stock.lots[0]!.facilityName).toBe('Facility A');
  });

  it('customer loading events surface movements', async () => {
    await recordInward({ organizationId: 'ORG-A', facilityId: 'FAC-A', commodityId: 'CMD-A', unitId: 'UNT-A', quantity: 10, ownerId: 'PRT-A', locationId: 'LOC-A' }, 'USR-A', 'InventoryOperator');
    const events = await customerLoadingEvents('PRT-A') as { movements: Array<{ type: string }> };
    expect(events.movements.length).toBeGreaterThan(0);
    expect(events.movements[0]!.type).toBe('Inward');
  });

  it('customer finance returns empty state with correct shape', async () => {
    const finance = await customerFinance('PRT-A') as { summary: { outstanding: number }; bills: unknown[] };
    expect(finance.summary.outstanding).toBe(0);
    expect(finance.bills).toEqual([]);
  });
});

describe('employee terminal', () => {
  it('resolves the facility and lists locations', async () => {
    const env = await employeeEnvironment('FAC-A') as { facility: { name: string }; locations: Array<{ name: string }> };
    expect(env.facility.name).toBe('Facility A');
    expect(env.locations[0]!.name).toBe('A');
  });

  it('today and yesterday return empty loading plans', async () => {
    const today = await employeeToday('FAC-A') as { gatepasses: unknown[] };
    const yesterday = await employeeYesterday('FAC-A') as { gatepasses: unknown[] };
    expect(today.gatepasses).toEqual([]);
    expect(yesterday.gatepasses).toEqual([]);
  });
});

describe('finance depth', () => {
  it('builds cash flow, ledgers, day book, GST and consolidated views from empty books', async () => {
    await ensureDefaultAccounts('ORG-A');
    const cashflow = await generateCashFlow({ organizationId: 'ORG-A' }) as { netCashFlow: number };
    expect(cashflow.netCashFlow).toBe(0);
    const ledger = await partyLedger({ organizationId: 'ORG-A', partyId: 'PRT-A' }) as { rows: unknown[] };
    expect(ledger.rows).toEqual([]);
    const book = await dayBook({ organizationId: 'ORG-A' }) as { entries: unknown[] };
    expect(book.entries).toEqual([]);
    const gst = await gstSummary({ organizationId: 'ORG-A' }) as { netPayable: number };
    expect(gst.netPayable).toBe(0);
    const consolidated = await consolidatedStatements() as { organizations: Array<{ organizationId: string }> };
    expect(consolidated.organizations.length).toBe(1);
  });

  it('reflects a bill in statements and outstanding after posting', async () => {
    await ensureDefaultAccounts('ORG-A');
    const { createBill, postBill } = await import('../../src/modules/warehouse/finance.service.js');
    const { ChargeType } = await import('../../src/modules/warehouse/master.models.js');
    await ChargeType.create({ chargeTypeId: 'CHG-A', organizationId: 'ORG-A', facilityId: 'FAC-A', name: 'Storage', billType: 'Storage', base: 'quantity', rate: 5, taxRatePct: 0 });
    const bill = await createBill({ organizationId: 'ORG-A', facilityId: 'FAC-A', customerId: 'PRT-A', lines: [{ chargeTypeId: 'CHG-A', quantity: 10 }] }, 'USR-A', 'OrgAdmin') as { billId: string };
    await postBill({ organizationId: 'ORG-A', billId: bill.billId, facilityId: 'FAC-A' }, 'USR-A', 'OrgAdmin');
    const statements = await generateFinancialStatements({ organizationId: 'ORG-A' }) as { pnl: { income: number }; balanceSheet: { assets: number } };
    expect(statements.pnl.income).toBe(50);
    expect(statements.balanceSheet.assets).toBe(50);
    const cashflow = await generateCashFlow({ organizationId: 'ORG-A' }) as { netCashFlow: number };
    expect(cashflow.netCashFlow).toBe(0); // no cash moved yet, only AR accrued
  });
});