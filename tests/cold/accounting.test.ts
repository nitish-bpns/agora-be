import { beforeEach, describe, expect, it } from 'vitest';
import { Organization, Facility, Party, FacilityUser } from '../../src/modules/warehouse/org.models.js';
import { Account, ChargeType, Commodity, StorageLocation, Unit } from '../../src/modules/warehouse/master.models.js';
import { JournalEntry, Bill } from '../../src/modules/warehouse/finance.models.js';
import { createBill, postBill, createPayment, reverseJournal, generateFinancialStatements, customerOutstanding, ensureDefaultAccounts } from '../../src/modules/warehouse/finance.service.js';
import { clearDatabase } from './test-db.js';

const orgId = 'ORG-F1';
const facilityId = 'FAC-F1';
const customerId = 'PRT-F1';
const ACCOUNTS_OPERATOR = 'USR-F1';

async function seed(): Promise<void> {
  await Organization.create({ organizationId: orgId, name: 'Org' });
  await Facility.create({ facilityId, organizationId: orgId, name: 'Facility', code: 'F1' });
  await Party.create({ partyId: customerId, organizationId: orgId, partyType: 'Customer', name: 'Customer' });
  await Unit.create({ unitId: 'UNT-F1', organizationId: orgId, code: 'BAG', name: 'Bag', category: 'Count', baseWeightKg: 50 });
  await Commodity.create({ commodityId: 'CMD-F1', organizationId: orgId, name: 'Potato' });
  await StorageLocation.create({ locationId: 'LOC-F1', organizationId: orgId, facilityId, type: 'Chamber', name: 'A', code: 'A', capacityBags: 1000 });
  await ChargeType.create({ chargeTypeId: 'CHG-F1', organizationId: orgId, facilityId, name: 'Storage rent', billType: 'Storage', base: 'bags', rate: 10, taxRatePct: 18 });
  await Account.create({ accountId: 'ACT-F1', organizationId: orgId, code: 'AR', name: 'Accounts Receivable', accountType: 'Asset', isDefault: true });
  await Account.create({ accountId: 'ACT-F2', organizationId: orgId, code: 'CASH', name: 'Cash', accountType: 'Asset', isDefault: true });
  await Account.create({ accountId: 'ACT-F3', organizationId: orgId, code: 'INC-STORAGE', name: 'Storage Income', accountType: 'Income', isDefault: true });
  await Account.create({ accountId: 'ACT-F4', organizationId: orgId, code: 'LIAB-GST', name: 'GST Payable (Output)', accountType: 'Liability', isDefault: true });
  await Account.create({ accountId: 'ACT-F5', organizationId: orgId, code: 'INC-DISCOUNT', name: 'Discounts Allowed', accountType: 'Expense', isDefault: true });
  await FacilityUser.create({ facilityUserId: 'FCU-F1', organizationId: orgId, facilityId, userId: ACCOUNTS_OPERATOR, role: 'AccountsOperator' });
}

beforeEach(async () => {
  await clearDatabase();
  await seed();
});

describe('double-entry accounting', () => {
  it('posting a draft bill creates a balanced journal entry', async () => {
    const bill = await createBill({
      organizationId: orgId, facilityId, customerId,
      lines: [{ chargeTypeId: 'CHG-F1', quantity: 100 }]
    }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const billId = String((bill as { billId: string }).billId);
    const posted = await postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    expect((posted as { status: string }).status).toBe('Posted');
    const journal = await JournalEntry.findOne({ sourceId: billId }).lean();
    expect(journal).toBeTruthy();
    const totalDebit = journal!.lines.reduce((sum, line) => sum + line.debit, 0);
    const totalCredit = journal!.lines.reduce((sum, line) => sum + line.credit, 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.02);
    // 100 bags * 10 = 1000 + 18% GST = 1180 total
    expect(Math.round(journal!.lines[0]!.debit)).toBe(1180);
  });

  it('cannot post a bill twice', async () => {
    const bill = await createBill({ organizationId: orgId, facilityId, customerId, lines: [{ chargeTypeId: 'CHG-F1', quantity: 10 }] }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const billId = String((bill as { billId: string }).billId);
    await postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    await expect(postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator')).rejects.toThrow('expected Draft');
  });

  it('receipt against a bill updates paid amount and balance', async () => {
    const bill = await createBill({ organizationId: orgId, facilityId, customerId, lines: [{ chargeTypeId: 'CHG-F1', quantity: 50 }] }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const billId = String((bill as { billId: string }).billId);
    await postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const postedBill = await Bill.findOne({ billId }).lean();
    const total = postedBill!.total;
    await createPayment({
      organizationId: orgId, facilityId, paymentType: 'Receipt', partyId: customerId,
      method: 'Cash', amount: total, allocatedTo: [{ billId, amount: total }]
    }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const updated = await Bill.findOne({ billId }).lean();
    expect(updated?.paidAmount).toBe(total);
    expect(updated?.status).toBe('Paid');
    const outstanding = await customerOutstanding(orgId, facilityId);
    expect(outstanding).toHaveLength(0);
  });

  it('receipt can only allocate up to outstanding amount', async () => {
    const bill = await createBill({ organizationId: orgId, facilityId, customerId, lines: [{ chargeTypeId: 'CHG-F1', quantity: 10 }] }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const billId = String((bill as { billId: string }).billId);
    await postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const postedBill = await Bill.findOne({ billId }).lean();
    const total = postedBill!.total;
    await expect(createPayment({
      organizationId: orgId, facilityId, paymentType: 'Receipt', partyId: customerId,
      method: 'Cash', amount: total + 100, allocatedTo: [{ billId, amount: total + 100 }]
    }, ACCOUNTS_OPERATOR, 'AccountsOperator')).rejects.toThrow('outstanding');
  });

  it('journal reversal is auditable and re-balances', async () => {
    const bill = await createBill({ organizationId: orgId, facilityId, customerId, lines: [{ chargeTypeId: 'CHG-F1', quantity: 10 }] }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const billId = String((bill as { billId: string }).billId);
    await postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const journal = await JournalEntry.findOne({ sourceId: billId }).lean();
    const result = await reverseJournal({ organizationId: orgId, journalId: journal!.journalId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const reversalId = (result as { reversalId: string }).reversalId;
    const original = await JournalEntry.findOne({ journalId: journal!.journalId }).lean();
    const reversal = await JournalEntry.findOne({ journalId: reversalId }).lean();
    expect(original?.status).toBe('Reversed');
    expect(reversal?.lines).toHaveLength(journal!.lines.length);
    // Net impact of original + reversal = 0
    const netPerAccount = new Map<string, number>();
    for (const entry of [original!, reversal!]) {
      for (const line of entry.lines) {
        netPerAccount.set(line.accountId, (netPerAccount.get(line.accountId) ?? 0) + line.debit - line.credit);
      }
    }
    for (const value of netPerAccount.values()) expect(Math.abs(value)).toBeLessThan(0.01);
  });

  it('trial balance reconciles from posted journals only', async () => {
    const bill = await createBill({ organizationId: orgId, facilityId, customerId, lines: [{ chargeTypeId: 'CHG-F1', quantity: 100 }] }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const billId = String((bill as { billId: string }).billId);
    await postBill({ organizationId: orgId, billId, facilityId }, ACCOUNTS_OPERATOR, 'AccountsOperator');
    const statements = await generateFinancialStatements({ organizationId: orgId });
    const tb = (statements as { trialBalance: { totalDebit: number; totalCredit: number } }).trialBalance;
    expect(tb.totalDebit).toBeCloseTo(tb.totalCredit, 2);
    expect(tb.totalDebit).toBeGreaterThan(0);
    const pnl = (statements as { pnl: { income: number } }).pnl;
    expect(pnl.income).toBeGreaterThan(0);
  });

  it('ensures default accounts are idempotent', async () => {
    await ensureDefaultAccounts(orgId);
    await ensureDefaultAccounts(orgId);
    const accounts = await Account.find({ organizationId: orgId, isDefault: true }).lean();
    const codes = accounts.map((a) => a.code);
    expect(codes).toContain('AR');
    expect(codes).toContain('CASH');
  });

  it('rejects payment creation by non-accounts roles', async () => {
    await expect(createPayment({
      organizationId: orgId, facilityId, paymentType: 'Receipt', partyId: customerId,
      method: 'Cash', amount: 10, allocatedTo: []
    }, 'USR-F9', 'InventoryOperator')).rejects.toThrow('accounts-role');
  });
});
