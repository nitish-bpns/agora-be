import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/* ------------------------------------------------------------------ */
/* Financial periods                                                   */
/* ------------------------------------------------------------------ */

const financialPeriodSchema = new Schema({
  periodId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null },
  name: { type: String, required: true }, // e.g. FY 2026-27
  startsOn: { type: Date, required: true },
  endsOn: { type: Date, required: true },
  isClosed: { type: Boolean, default: false }
}, options);
export const FinancialPeriod = model('FinancialPeriod', financialPeriodSchema);

/* ------------------------------------------------------------------ */
/* Journal entries (double-entry, append-only, must balance)           */
/* ------------------------------------------------------------------ */

export const JOURNAL_SOURCES = ['Billing', 'Receipt', 'Payment', 'Manual', 'Correction', 'Reversal'] as const;
export const ENTRY_STATUSES = ['Posted', 'Reversed'] as const;

const journalEntrySchema = new Schema({
  journalId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null, index: true },
  periodId: { type: String, default: null },
  entryDate: { type: Date, required: true },
  source: { type: String, enum: JOURNAL_SOURCES, required: true },
  sourceType: { type: String, default: '' }, // e.g. 'Bill', 'Receipt'
  sourceId: { type: String, default: null },
  narration: { type: String, default: '' },
  status: { type: String, enum: ENTRY_STATUSES, default: 'Posted' },
  reversedById: { type: String, default: null }, // journalId of reversing entry
  reversedFromId: { type: String, default: null }, // journalId that this reverses
  lines: [{
    lineId: { type: String, required: true },
    accountId: { type: String, required: true },
    partyId: { type: String, default: null },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: { type: String, default: '' }
  }],
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, options);
journalEntrySchema.index({ organizationId: 1, entryDate: 1 });
journalEntrySchema.index({ accountId: 1, entryDate: 1 });
export const JournalEntry = model('JournalEntry', journalEntrySchema);

/* ------------------------------------------------------------------ */
/* Bills (storage charges etc.)                                        */
/* ------------------------------------------------------------------ */

export const BILL_STATUSES = ['Draft', 'Posted', 'PartiallyPaid', 'Paid', 'Reversed'] as const;

const billSchema = new Schema({
  billId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  billNumber: { type: String, required: true },
  customerId: { type: String, required: true, index: true }, // partyId
  billDate: { type: Date, required: true },
  dueDate: { type: Date, default: null },
  periodFrom: { type: Date, default: null },
  periodTo: { type: Date, default: null },
  status: { type: String, enum: BILL_STATUSES, default: 'Draft' },
  lines: [{
    lineId: { type: String, required: true },
    chargeTypeId: { type: String, default: null },
    description: { type: String, default: '' },
    base: { type: String, default: 'quantity' },
    quantity: { type: Number, default: 0 },
    unitId: { type: String, default: null },
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    taxRatePct: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    lotId: { type: String, default: null },
    // keep calculation details for explanation/audit
    calculation: { type: Schema.Types.Mixed, default: {} }
  }],
  subtotal: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  paidAmount: { type: Number, default: 0 },
  journalId: { type: String, default: null },
  notes: { type: String, default: '' },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, options);
billSchema.index({ organizationId: 1, facilityId: 1, customerId: 1 });
export const Bill = model('Bill', billSchema);

/* ------------------------------------------------------------------ */
/* Receipts & payments                                                 */
/* ------------------------------------------------------------------ */

export const PAYMENT_TYPES = ['Receipt', 'Payment'] as const;
export const PAYMENT_METHODS = ['Cash', 'BankTransfer', 'Cheque', 'UPI', 'Card', 'Other'] as const;

const paymentSchema = new Schema({
  paymentId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  paymentType: { type: String, enum: PAYMENT_TYPES, required: true },
  partyId: { type: String, required: true, index: true },
  paymentDate: { type: Date, required: true },
  method: { type: String, enum: PAYMENT_METHODS, required: true },
  referenceNumber: { type: String, default: '' },
  amount: { type: Number, required: true, min: 0.01 },
  allocatedTo: [{
    billId: { type: String, required: true },
    amount: { type: Number, required: true }
  }],
  journalId: { type: String, default: null },
  clientOpId: { type: String, default: null }, // offline idempotency key (indexed below)
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, options);
paymentSchema.index({ clientOpId: 1 }, { unique: true, partialFilterExpression: { clientOpId: { $type: 'string' } } });
export const Payment = model('Payment', paymentSchema);
