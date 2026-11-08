import mongoose from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Account, ChargeType } from './master.models.js';
import { Bill, FinancialPeriod, JournalEntry, Payment } from './finance.models.js';
import { assertFacilityInOrg } from './org.service.js';
import { isAccountsRole } from './context.js';

const AUDIT_REALM = 'Storage';

function requireAccountsRole(role: string): void {
  if (!isAccountsRole(role)) throw new ApiError(403, 'This operation requires an accounts-role identity', 'COLD_FORBIDDEN');
}

const DEFAULT_ACCOUNT_CODES = {
  accountsReceivable: 'AR',
  accountsPayable: 'AP',
  cash: 'CASH',
  bank: 'BANK',
  storageIncome: 'INC-STORAGE',
  handlingIncome: 'INC-HANDLING',
  transportIncome: 'INC-TRANSPORT',
  taxLiability: 'LIAB-GST',
  discount: 'INC-DISCOUNT',
  capital: 'EQ-CAPITAL',
  retainedEarnings: 'EQ-RETAINED'
} as const;

export async function ensureDefaultAccounts(organizationId: string): Promise<void> {
  const existing = await Account.findOne({ organizationId });
  if (existing) return;
  const defaults: Array<{ code: string; name: string; accountType: string }> = [
    { code: DEFAULT_ACCOUNT_CODES.accountsReceivable, name: 'Accounts Receivable', accountType: 'Asset' },
    { code: DEFAULT_ACCOUNT_CODES.accountsPayable, name: 'Accounts Payable', accountType: 'Liability' },
    { code: DEFAULT_ACCOUNT_CODES.cash, name: 'Cash', accountType: 'Asset' },
    { code: DEFAULT_ACCOUNT_CODES.bank, name: 'Bank', accountType: 'Asset' },
    { code: DEFAULT_ACCOUNT_CODES.storageIncome, name: 'Storage Income', accountType: 'Income' },
    { code: DEFAULT_ACCOUNT_CODES.handlingIncome, name: 'Handling Income', accountType: 'Income' },
    { code: DEFAULT_ACCOUNT_CODES.transportIncome, name: 'Transport Income', accountType: 'Income' },
    { code: DEFAULT_ACCOUNT_CODES.taxLiability, name: 'GST Payable (Output)', accountType: 'Liability' },
    { code: DEFAULT_ACCOUNT_CODES.discount, name: 'Discounts Allowed', accountType: 'Expense' },
    { code: DEFAULT_ACCOUNT_CODES.capital, name: 'Owner Capital', accountType: 'Equity' },
    { code: DEFAULT_ACCOUNT_CODES.retainedEarnings, name: 'Retained Earnings', accountType: 'Equity' }
  ];
  const docs = [];
  for (const d of defaults) {
    docs.push({ accountId: await nextId('account'), organizationId, code: d.code, name: d.name, accountType: d.accountType, isDefault: true });
  }
  await Account.insertMany(docs);
}

async function findAccount(organizationId: string, code: string): Promise<{ accountId: string }> {
  await ensureDefaultAccounts(organizationId);
  const account = await Account.findOne({ organizationId, code }).lean();
  if (!account) throw new ApiError(500, `Default account ${code} is missing`);
  return account;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function applyRounding(value: number, rule: string): number {
  switch (rule) {
    case 'round': return Math.round(value);
    case 'ceil': return Math.ceil(value);
    case 'floor': return Math.floor(value);
    default: return Math.round(value * 100) / 100;
  }
}

/* ------------------------------------------------------------------ */
/* Billing                                                             */
/* ------------------------------------------------------------------ */

export async function createBill(input: {
  organizationId: string; facilityId: string; customerId: string; billDate?: string;
  dueDate?: string | null; periodFrom?: string | null; periodTo?: string | null;
  lines: Array<{ chargeTypeId: string; quantity?: number; unitId?: string | null; description?: string; lotId?: string | null }>;
  discount?: number; note?: string;
}, actorId: string, role: string): Promise<object> {
  requireAccountsRole(role);
  await assertFacilityInOrg(input.organizationId, input.facilityId);
  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      const billLines = [];
      for (const line of input.lines) {
        const chargeType = await ChargeType.findOne({ chargeTypeId: line.chargeTypeId, organizationId: input.organizationId, facilityId: input.facilityId, status: 'Active' }).lean();
        if (!chargeType) throw new ApiError(404, `Charge type ${line.chargeTypeId} was not found`);
        const quantity = line.quantity ?? 1;
        let amount = 0;
        const calculation: Record<string, unknown> = {};
        if (chargeType.base === 'contract' && typeof chargeType.ruleConfig === 'object' && chargeType.ruleConfig) {
          // slab rule: [{ upto: X, rate: Y }, ...] — rate of the slab containing quantity
          const slabs = (chargeType.ruleConfig as { slabs?: Array<{ upto?: number; rate: number }> }).slabs ?? [];
          let rate = chargeType.rate;
          for (const slab of slabs) {
            if (slab.upto === undefined || quantity <= slab.upto) { rate = slab.rate; break; }
          }
          amount = quantity * rate;
          calculation.slabRate = rate;
        } else {
          amount = quantity * chargeType.rate;
        }
        amount = applyRounding(amount, chargeType.roundingRule);
        const taxAmount = round(amount * (chargeType.taxRatePct / 100));
        const billType = chargeType.billType;
        billLines.push({
          lineId: await nextId('movement'), chargeTypeId: chargeType.chargeTypeId,
          description: line.description ?? chargeType.name, base: chargeType.base,
          quantity, unitId: line.unitId ?? chargeType.unitId ?? null, rate: chargeType.rate,
          amount: round(amount), taxRatePct: chargeType.taxRatePct, taxAmount, total: round(amount + taxAmount),
          lotId: line.lotId ?? null, calculation: { ...calculation, freeDays: chargeType.freeDays, minPeriodDays: chargeType.minimumPeriodDays, billType }
        });
      }
      const subtotal = round(billLines.reduce((sum, line) => sum + line.amount, 0));
      const taxTotal = round(billLines.reduce((sum, line) => sum + line.taxAmount, 0));
      const discount = Math.min(input.discount ?? 0, subtotal);
      const total = round(subtotal + taxTotal - discount);

      const billId = await nextId('bill');
      const billNumber = `BILL-${billId.slice(4)}`;
      const [bill] = await Bill.create([{
        billId, organizationId: input.organizationId, facilityId: input.facilityId, billNumber,
        customerId: input.customerId, billDate: input.billDate ? new Date(input.billDate) : new Date(),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        periodFrom: input.periodFrom ? new Date(input.periodFrom) : null,
        periodTo: input.periodTo ? new Date(input.periodTo) : null,
        status: 'Draft', lines: billLines, subtotal, discount, taxTotal, total,
        notes: input.note ?? '', createdBy: actorId
      }], { session });
      result = bill!.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'bills', recordId: String((result as { billId?: string }).billId ?? ''), action: 'Create (Draft)', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Posts a draft bill, creating the AR journal entry atomically. */
export async function postBill(input: { organizationId: string; billId: string; facilityId: string }, actorId: string, role: string): Promise<object> {
  requireAccountsRole(role);
  const session = await mongoose.startSession();
  try {
    let result: object;
    await session.withTransaction(async () => {
      const bill = await Bill.findOne({ billId: input.billId, organizationId: input.organizationId }).session(session);
      if (!bill) throw new ApiError(404, `Bill ${input.billId} was not found`);
      if (bill.status !== 'Draft') throw new ApiError(409, `Bill is ${bill.status}, expected Draft`);

      const arAccount = await findAccount(input.organizationId, DEFAULT_ACCOUNT_CODES.accountsReceivable);
      const taxAccount = await findAccount(input.organizationId, DEFAULT_ACCOUNT_CODES.taxLiability);
      const period = await FinancialPeriod.findOne({ organizationId: input.organizationId, startsOn: { $lte: bill.billDate }, endsOn: { $gte: bill.billDate } }).sort({ startsOn: -1 }).lean();

      const journalId = await nextId('journal');
      const lines = [];
      // Debit: Accounts Receivable
      lines.push({ lineId: await nextId('journal'), accountId: arAccount.accountId, partyId: bill.customerId, debit: bill.total, credit: 0, description: `Bill ${bill.billNumber}` });
      for (const line of bill.lines) {
        const incomeCode = line.base === 'transport' || (line.calculation?.billType === 'Transport') ? DEFAULT_ACCOUNT_CODES.transportIncome
          : line.calculation?.billType === 'HandlingInward' || line.calculation?.billType === 'HandlingOutward' ? DEFAULT_ACCOUNT_CODES.handlingIncome
            : DEFAULT_ACCOUNT_CODES.storageIncome;
        const incomeAccount = await findAccount(input.organizationId, incomeCode);
        lines.push({ lineId: await nextId('journal'), accountId: incomeAccount.accountId, debit: 0, credit: line.amount, description: line.description });
        if (line.taxAmount > 0) {
          lines.push({ lineId: await nextId('journal'), accountId: taxAccount.accountId, debit: 0, credit: line.taxAmount, description: `${line.description} — GST` });
        }
      }
      if (bill.discount > 0) {
        const discountAccount = await findAccount(input.organizationId, DEFAULT_ACCOUNT_CODES.discount);
        lines.push({ lineId: await nextId('journal'), accountId: discountAccount.accountId, debit: bill.discount, credit: 0, description: 'Discount allowed' });
      }
      const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
      const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw new ApiError(500, `Journal does not balance (debit ${totalDebit}, credit ${totalCredit})`, 'UNBALANCED_JOURNAL');
      }
      await JournalEntry.create([{
        journalId, organizationId: input.organizationId, facilityId: input.facilityId,
        periodId: period?.periodId ?? null, entryDate: bill.billDate, source: 'Billing', sourceType: 'Bill',
        sourceId: bill.billId, narration: `Bill ${bill.billNumber}`, status: 'Posted', lines, createdBy: actorId
      }], { session });
      bill.journalId = journalId;
      bill.status = 'Posted';
      await bill.save({ session });
      result = bill.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'bills', recordId: input.billId, action: 'Post', actorId });
    return result!;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Receipts & payments                                                */
/* ------------------------------------------------------------------ */

export async function createPayment(input: {
  organizationId: string; facilityId: string; paymentType: string; partyId: string; paymentDate?: string;
  method: string; referenceNumber?: string; amount: number;
  allocatedTo: Array<{ billId: string; amount: number }>;
  clientOpId?: string | null;
}, actorId: string, role: string): Promise<object> {
  requireAccountsRole(role);
  await assertFacilityInOrg(input.organizationId, input.facilityId);
  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      const dup = await Payment.findOne({ clientOpId: input.clientOpId ?? '' }).session(session);
      if (dup) throw new ApiError(409, 'This operation was already recorded', 'DUPLICATE_OP');

      const allocatedTotal = input.allocatedTo.reduce((sum, a) => sum + a.amount, 0);
      if (Math.abs(allocatedTotal - input.amount) > 0.01) throw new ApiError(400, 'Allocations must sum to the payment amount');
      for (const allocation of input.allocatedTo) {
        const bill = await Bill.findOne({ billId: allocation.billId, organizationId: input.organizationId }).session(session);
        if (!bill) throw new ApiError(404, `Bill ${allocation.billId} was not found`);
        const remaining = bill.total - bill.paidAmount;
        if (allocation.amount > remaining + 0.01) throw new ApiError(409, `Allocation exceeds outstanding on bill ${bill.billNumber}`);
      }
      const arAccount = await findAccount(input.organizationId, DEFAULT_ACCOUNT_CODES.accountsReceivable);
      const cashAccount = await findAccount(input.organizationId, input.method === 'Cash' ? DEFAULT_ACCOUNT_CODES.cash : DEFAULT_ACCOUNT_CODES.bank);

      const paymentId = await nextId('payment');
      const journalId = await nextId('journal');
      const accountPostingCode = input.paymentType === 'Receipt' ? DEFAULT_ACCOUNT_CODES.bank : DEFAULT_ACCOUNT_CODES.accountsReceivable;
      const accountPosting = await findAccount(input.organizationId, input.paymentType === 'Receipt' ? (input.method === 'Cash' ? DEFAULT_ACCOUNT_CODES.cash : DEFAULT_ACCOUNT_CODES.bank) : accountPostingCode);
      // Receipt: debit cash/bank, credit AR. Payment: debit AP, credit cash/bank.
      const lines = input.paymentType === 'Receipt'
        ? [
            { lineId: await nextId('journal'), accountId: cashAccount.accountId, debit: input.amount, credit: 0, description: `Receipt from ${input.partyId}` },
            { lineId: await nextId('journal'), accountId: arAccount.accountId, partyId: input.partyId, debit: 0, credit: input.amount, description: 'Receipt allocation' }
          ]
        : [
            { lineId: await nextId('journal'), accountId: accountPosting.accountId, partyId: input.partyId, debit: input.amount, credit: 0, description: `Payment to ${input.partyId}` },
            { lineId: await nextId('journal'), accountId: cashAccount.accountId, debit: 0, credit: input.amount, description: 'Payment' }
          ];
      await JournalEntry.create([{
        journalId, organizationId: input.organizationId, facilityId: input.facilityId, entryDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
        source: input.paymentType === 'Receipt' ? 'Receipt' : 'Payment', sourceType: input.paymentType, sourceId: paymentId,
        narration: input.paymentType === 'Receipt' ? `Receipt ${paymentId}` : `Payment ${paymentId}`, status: 'Posted', lines, createdBy: actorId
      }], { session });
      await Payment.create([{
        paymentId, organizationId: input.organizationId, facilityId: input.facilityId, paymentType: input.paymentType,
        partyId: input.partyId, paymentDate: input.paymentDate ? new Date(input.paymentDate) : new Date(),
        method: input.method, referenceNumber: input.referenceNumber ?? '', amount: input.amount,
        allocatedTo: input.allocatedTo, journalId, clientOpId: input.clientOpId ?? null, createdBy: actorId
      }], { session });
      for (const allocation of input.allocatedTo) {
        await Bill.updateOne({ billId: allocation.billId }, { $inc: { paidAmount: allocation.amount } }).session(session);
        const bill = await Bill.findOne({ billId: allocation.billId }).session(session);
        if (bill) {
          const nextStatus = bill.paidAmount >= bill.total - 0.01 ? 'Paid' : 'PartiallyPaid';
          await Bill.updateOne({ billId: allocation.billId }, { $set: { status: nextStatus } }).session(session);
        }
      }
      result = { paymentId, journalId };
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'payments', recordId: String((result as { paymentId?: string }).paymentId ?? ''), action: 'Create', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Reversals & corrections                                             */
/* ------------------------------------------------------------------ */

export async function reverseJournal(input: { organizationId: string; journalId: string }, actorId: string, role: string): Promise<object> {
  requireAccountsRole(role);
  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      const entry = await JournalEntry.findOne({ journalId: input.journalId, organizationId: input.organizationId }).session(session);
      if (!entry) throw new ApiError(404, `Journal ${input.journalId} was not found`);
      if (entry.status === 'Reversed') throw new ApiError(409, 'Journal is already reversed');
      const reversalId = await nextId('journal');
      const lines = [];
      for (const line of entry.lines) {
        lines.push({ lineId: await nextId('journal'), accountId: line.accountId, partyId: line.partyId ?? null, debit: line.credit, credit: line.debit, description: `Reversal of ${entry.journalId} — ${line.description}` });
      }
      await JournalEntry.create([{
        journalId: reversalId, organizationId: input.organizationId, facilityId: entry.facilityId, periodId: entry.periodId ?? null,
        entryDate: new Date(), source: 'Reversal', sourceType: entry.source, sourceId: entry.sourceId ?? null,
        narration: `Reversal of ${entry.journalId}`, status: 'Posted', lines, reversedFromId: entry.journalId, createdBy: actorId
      }], { session });
      entry.status = 'Reversed';
      entry.reversedById = reversalId;
      await entry.save({ session });
      result = { original: entry.toObject(), reversalId };
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'journals', recordId: input.journalId, action: 'Reverse', actorId });
    return result;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export async function generateFinancialStatements(input: { organizationId: string; from?: string; to?: string }): Promise<object> {
  const from = input.from ? new Date(input.from) : new Date(0);
  const to = input.to ? new Date(input.to) : new Date();
  const entries = await JournalEntry.find({ organizationId: input.organizationId, status: 'Posted', entryDate: { $gte: from, $lte: to } }).lean();
  const balances = new Map<string, number>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      balances.set(line.accountId, (balances.get(line.accountId) ?? 0) + line.debit - line.credit);
    }
  }
  const accounts = await Account.find({ organizationId: input.organizationId }).lean();
  const rows = accounts.map((account) => ({
    accountId: account.accountId, code: account.code, name: account.name, accountType: account.accountType,
    balance: balances.get(account.accountId) ?? 0
  }));
  const trialBalance = {
    totalDebit: round(rows.reduce((sum, row) => sum + (row.balance > 0 ? row.balance : 0), 0)),
    totalCredit: round(rows.reduce((sum, row) => sum + (row.balance < 0 ? -row.balance : 0), 0)),
    rows
  };
  const pnl = {
    income: round(Math.abs(rows.filter((row) => row.accountType === 'Income' && row.balance < 0).reduce((sum, row) => sum + row.balance, 0))),
    expense: round(rows.filter((row) => row.accountType === 'Expense' && row.balance > 0).reduce((sum, row) => sum + row.balance, 0)),
    netProfit: 0
  };
  pnl.netProfit = round(pnl.income - pnl.expense);
  const balanceSheet = {
    assets: round(rows.filter((row) => row.accountType === 'Asset' && row.balance > 0).reduce((sum, row) => sum + row.balance, 0)),
    liabilities: round(Math.abs(rows.filter((row) => row.accountType === 'Liability' && row.balance < 0).reduce((sum, row) => sum + row.balance, 0))),
    equity: round(Math.abs(rows.filter((row) => row.accountType === 'Equity' && row.balance < 0).reduce((sum, row) => sum + row.balance, 0)) + pnl.netProfit)
  };
  return { trialBalance, pnl, balanceSheet, period: { from: from.toISOString(), to: to.toISOString() } };
}

export async function customerOutstanding(organizationId: string, facilityId?: string): Promise<object[]> {
  const filter: Record<string, unknown> = { organizationId, status: { $in: ['Posted', 'PartiallyPaid'] } };
  if (facilityId) filter.facilityId = facilityId;
  const bills = await Bill.find(filter).sort({ customerId: 1, billDate: 1 }).lean();
  const byCustomer = new Map<string, { customerId: string; total: number; paid: number; outstanding: number; bills: number }>();
  for (const bill of bills) {
    const row = byCustomer.get(bill.customerId) ?? { customerId: bill.customerId, total: 0, paid: 0, outstanding: 0, bills: 0 };
    row.total += bill.total;
    row.paid += bill.paidAmount;
    row.outstanding += bill.total - bill.paidAmount;
    row.bills += 1;
    byCustomer.set(bill.customerId, row);
  }
  return [...byCustomer.values()].sort((a, b) => b.outstanding - a.outstanding);
}

export async function listBills(input: { organizationId: string; customerId?: string; status?: string; facilityId?: string; page?: number; limit?: number }): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.customerId) filter.customerId = input.customerId;
  if (input.status) filter.status = input.status;
  if (input.facilityId) filter.facilityId = input.facilityId;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Bill.find(filter).sort({ billDate: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Bill.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

/* ------------------------------------------------------------------ */
/* Phase 3 finance depth: cashflow, ledgers, day book, GST, consolidated */
/* ------------------------------------------------------------------ */

/** Cash flow statement: operating / investing / financing from posted journals. */
export async function generateCashFlow(input: { organizationId: string; from?: string; to?: string }): Promise<object> {
  const from = input.from ? new Date(input.from) : new Date(0);
  const to = input.to ? new Date(input.to) : new Date();
  const entries = await JournalEntry.find({ organizationId: input.organizationId, status: 'Posted', entryDate: { $gte: from, $lte: to } }).lean();
  const accounts = await Account.find({ organizationId: input.organizationId }).lean();
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));

  let operating = 0;
  let investing = 0;
  let financing = 0;
  const detail: Array<{ date: Date; narration: string; source: string; category: string; amount: number }> = [];

  for (const entry of entries) {
    for (const line of entry.lines) {
      const account = accountMap.get(line.accountId);
      if (!account) continue;
      const net = line.debit - line.credit;
      // Cash/bank movements drive cash flow; classify by the counterpart account type.
      if (account.code === 'CASH' || account.code === 'BANK') {
        const counterpart = entry.lines.find((l) => l.lineId !== line.lineId);
        const counterpartAccount = counterpart ? accountMap.get(counterpart.accountId) : undefined;
        const category = counterpartAccount?.accountType === 'Income' || counterpartAccount?.accountType === 'Expense' || counterpartAccount?.code === 'AR' || counterpartAccount?.code === 'AP'
          ? 'Operating'
          : counterpartAccount?.accountType === 'Asset' ? 'Investing'
            : counterpartAccount?.accountType === 'Equity' || counterpartAccount?.accountType === 'Liability' ? 'Financing'
              : 'Operating';
        if (category === 'Operating') operating += net;
        else if (category === 'Investing') investing += net;
        else financing += net;
        detail.push({ date: entry.entryDate, narration: entry.narration, source: entry.source, category, amount: net });
      }
    }
  }

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    operating: round(operating),
    investing: round(investing),
    financing: round(financing),
    netCashFlow: round(operating + investing + financing),
    detail: detail.sort((a, b) => a.date.getTime() - b.date.getTime())
  };
}

/** Party-wise ledger: all journal lines touching a party, with running balance. */
export async function partyLedger(input: { organizationId: string; partyId: string; from?: string; to?: string }): Promise<object> {
  const from = input.from ? new Date(input.from) : new Date(0);
  const to = input.to ? new Date(input.to) : new Date();
  const entries = await JournalEntry.find({
    organizationId: input.organizationId, status: 'Posted', entryDate: { $gte: from, $lte: to },
    'lines.partyId': input.partyId
  }).sort({ entryDate: 1 }).lean();
  const accounts = await Account.find({ organizationId: input.organizationId }).lean();
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  const rows: Array<{ date: Date; journalId: string; narration: string; account: string; debit: number; credit: number; balance: number }> = [];
  let balance = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.partyId !== input.partyId) continue;
      balance += line.debit - line.credit;
      rows.push({
        date: entry.entryDate, journalId: entry.journalId, narration: entry.narration,
        account: accountMap.get(line.accountId)?.name ?? line.accountId,
        debit: line.debit, credit: line.credit, balance: round(balance)
      });
    }
  }
  return { partyId: input.partyId, from: from.toISOString(), to: to.toISOString(), rows };
}

/** Day book / cash book: chronological register of all posted journals. */
export async function dayBook(input: { organizationId: string; from?: string; to?: string; facilityId?: string }): Promise<object> {
  const from = input.from ? new Date(input.from) : new Date(0);
  const to = input.to ? new Date(input.to) : new Date();
  const filter: Record<string, unknown> = { organizationId: input.organizationId, status: 'Posted', entryDate: { $gte: from, $lte: to } };
  if (input.facilityId) filter.facilityId = input.facilityId;
  const entries = await JournalEntry.find(filter).sort({ entryDate: 1 }).lean();
  const accounts = await Account.find({ organizationId: input.organizationId }).lean();
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  return {
    from: from.toISOString(), to: to.toISOString(),
    entries: entries.map((entry) => ({
      journalId: entry.journalId, date: entry.entryDate, source: entry.source, sourceType: entry.sourceType,
      narration: entry.narration, facilityId: entry.facilityId,
      lines: entry.lines.map((line) => ({
        account: accountMap.get(line.accountId)?.name ?? line.accountId,
        partyId: line.partyId, debit: line.debit, credit: line.credit, description: line.description
      })),
      totalDebit: round(entry.lines.reduce((sum, l) => sum + l.debit, 0)),
      totalCredit: round(entry.lines.reduce((sum, l) => sum + l.credit, 0))
    }))
  };
}

/** GST summary: output tax (bills) vs input tax (payments) with net liability. */
export async function gstSummary(input: { organizationId: string; from?: string; to?: string }): Promise<object> {
  const from = input.from ? new Date(input.from) : new Date(0);
  const to = input.to ? new Date(input.to) : new Date();
  const bills = await Bill.find({ organizationId: input.organizationId, billDate: { $gte: from, $lte: to } }).lean();
  const outputTax = bills.reduce((sum, bill) => sum + bill.taxTotal, 0);
  const entries = await JournalEntry.find({ organizationId: input.organizationId, status: 'Posted', entryDate: { $gte: from, $lte: to } }).lean();
  const accounts = await Account.find({ organizationId: input.organizationId }).lean();
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  let inputTax = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      const account = accountMap.get(line.accountId);
      if (account && account.code === 'LIAB-GST' && line.debit > 0) inputTax += line.debit;
    }
  }
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    outputTax: round(outputTax),
    inputTax: round(inputTax),
    netPayable: round(outputTax - inputTax)
  };
}

/** Consolidated statements across all organizations (central manager view). */
export async function consolidatedStatements(): Promise<object> {
  const organizations = await import('./org.models.js').then((m) => m.Organization.find({ status: 'Active' }).lean());
  const rows = [];
  let totalIncome = 0;
  let totalExpense = 0;
  let totalOutstanding = 0;
  for (const org of organizations) {
    const statements = await generateFinancialStatements({ organizationId: org.organizationId });
    const statementsTyped = statements as { pnl: { income: number; expense: number; netProfit: number }; balanceSheet: { assets: number; liabilities: number } };
    const outstanding = await customerOutstanding(org.organizationId);
    const outstandingTyped = outstanding as Array<{ outstanding: number }>;
    const orgOutstanding = outstandingTyped.reduce((sum, row) => sum + row.outstanding, 0);
    totalIncome += statementsTyped.pnl.income;
    totalExpense += statementsTyped.pnl.expense;
    totalOutstanding += orgOutstanding;
    rows.push({
      organizationId: org.organizationId,
      name: org.name,
      income: statementsTyped.pnl.income,
      expense: statementsTyped.pnl.expense,
      netProfit: statementsTyped.pnl.netProfit,
      outstanding: round(orgOutstanding),
      assets: statementsTyped.balanceSheet.assets,
      liabilities: statementsTyped.balanceSheet.liabilities
    });
  }
  return {
    organizations: rows,
    totals: {
      income: round(totalIncome),
      expense: round(totalExpense),
      netProfit: round(totalIncome - totalExpense),
      outstanding: round(totalOutstanding)
    }
  };
}
