import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/* ------------------------------------------------------------------ */
/* Financers (external lenders)                                        */
/* ------------------------------------------------------------------ */

export const FINANCER_TYPES = ['Bank', 'NBFC', 'Cooperative', 'PrivateLender', 'StorageOwner', 'Other'] as const;
export const FINANCER_STATUSES = ['Active', 'Inactive', 'Blacklisted'] as const;

const financerSchema = new Schema({
  financerId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, default: null, index: true }, // null = network-level (central)
  name: { type: String, required: true, trim: true },
  financerType: { type: String, enum: FINANCER_TYPES, required: true },
  contactPerson: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },
  gstin: { type: String, default: '' },
  pan: { type: String, default: '' },
  // lending policy
  maxLoanAmount: { type: Number, default: 0 }, // 0 = no cap
  minLoanAmount: { type: Number, default: 0 },
  interestRatePct: { type: Number, default: 0 }, // default annual rate
  maxLtvPct: { type: Number, default: 70 }, // max loan-to-value on pledged stock
  tenureMonths: { type: Number, default: 12 },
  status: { type: String, enum: FINANCER_STATUSES, default: 'Active' }
}, options);
financerSchema.index({ organizationId: 1, name: 1 });
export const Financer = model('Financer', financerSchema);

/* ------------------------------------------------------------------ */
/* Pledge applications (customer → financer match-making)              */
/* ------------------------------------------------------------------ */

export const PLEDGE_APPLICATION_STATUSES = ['Draft', 'Submitted', 'UnderReview', 'Approved', 'Rejected', 'Withdrawn'] as const;

const pledgeApplicationSchema = new Schema({
  applicationId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  applicantPartyId: { type: String, required: true, index: true }, // customer party
  applicantUserId: { type: String, default: null }, // customer user who applied
  financerId: { type: String, default: null, index: true }, // null = open to all financers
  lotId: { type: String, required: true, index: true },
  commodityId: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  unitId: { type: String, required: true },
  // valuation
  stockValue: { type: Number, required: true, min: 0 }, // assessed value of pledged stock
  requestedAmount: { type: Number, required: true, min: 0 },
  requestedTenureMonths: { type: Number, default: 12 },
  purpose: { type: String, default: '' },
  status: { type: String, enum: PLEDGE_APPLICATION_STATUSES, default: 'Draft', index: true },
  statusReason: { type: String, default: '' },
  reviewedByFinancerId: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, options);
pledgeApplicationSchema.index({ applicantPartyId: 1, status: 1 });
pledgeApplicationSchema.index({ financerId: 1, status: 1 });
export const PledgeApplication = model('PledgeApplication', pledgeApplicationSchema);

/* ------------------------------------------------------------------ */
/* Pledges (active loans secured by stock)                             */
/* ------------------------------------------------------------------ */

export const PLEDGE_STATUSES = ['Active', 'PartiallyReleased', 'Closed', 'Defaulted'] as const;
/** Exchange-linked margin health. Exempt = no exchange price link (not revalued live). */
export const MARGIN_CALL_STATUSES = ['Healthy', 'Warning', 'MarginCall', 'Default', 'Exempt'] as const;

const pledgeSchema = new Schema({
  pledgeId: { type: String, required: true, unique: true, index: true },
  applicationId: { type: String, default: null, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  lotId: { type: String, required: true, index: true },
  borrowerPartyId: { type: String, required: true, index: true },
  financerId: { type: String, required: true, index: true },
  loanAmount: { type: Number, required: true, min: 0 },
  interestRatePct: { type: Number, required: true, min: 0 },
  tenureMonths: { type: Number, required: true, min: 1 },
  ltvPct: { type: Number, required: true, min: 0, max: 100 },
  stockValue: { type: Number, required: true, min: 0 },
  pledgedQuantity: { type: Number, required: true, min: 0 },
  unitId: { type: String, required: true },
  disbursedAt: { type: Date, default: null },
  dueDate: { type: Date, default: null },
  status: { type: String, enum: PLEDGE_STATUSES, default: 'Active', index: true },
  statusReason: { type: String, default: '' },
  // repayment tracking
  principalPaid: { type: Number, default: 0 },
  interestPaid: { type: Number, default: 0 },
  lastPaymentAt: { type: Date, default: null },
  // release tracking (partial release of pledged stock)
  releasedQuantity: { type: Number, default: 0 },
  /* ---- Exchange linkage (margin call monitoring) ---- */
  // Price at pledge approval: stockValue / pledgedQuantity per unit.
  pledgedPrice: { type: Number, default: 0 },
  exchangeSymbol: { type: String, default: null }, // commodity -> exchange symbol at approval
  linkedSymbol: { type: String, default: null }, // alias kept for clarity in UIs
  // LTV at which a margin call fires (e.g. 80%). Above this, the financer can demand
  // top-up; above 100% (collateral below loan) the pledge is in default.
  marginCallThresholdPct: { type: Number, default: 80 },
  marginCallStatus: { type: String, enum: MARGIN_CALL_STATUSES, default: 'Exempt', index: true },
  lastValuationPrice: { type: Number, default: null },
  lastValuationLtvPct: { type: Number, default: null },
  lastValuationAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  closedAt: { type: Date, default: null }
}, options);
pledgeSchema.index({ borrowerPartyId: 1, status: 1 });
pledgeSchema.index({ financerId: 1, status: 1 });
pledgeSchema.index({ marginCallStatus: 1, status: 1 });
export const Pledge = model('Pledge', pledgeSchema);

/* ------------------------------------------------------------------ */
/* Pledge interest accrual / repayment ledger                          */
/* ------------------------------------------------------------------ */

export const PLEDGE_TRANSACTION_TYPES = ['Disbursement', 'InterestAccrual', 'RepaymentPrincipal', 'RepaymentInterest', 'Release', 'Default', 'Closure', 'Valuation', 'MarginCall'] as const;

const pledgeTransactionSchema = new Schema({
  transactionId: { type: String, required: true, unique: true, index: true },
  pledgeId: { type: String, required: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null, index: true },
  type: { type: String, enum: PLEDGE_TRANSACTION_TYPES, required: true },
  amount: { type: Number, default: 0 },
  quantity: { type: Number, default: 0 }, // for releases
  interestRatePct: { type: Number, default: 0 },
  daysAccrued: { type: Number, default: 0 },
  narration: { type: String, default: '' },
  actorId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}, options);
pledgeTransactionSchema.index({ pledgeId: 1, createdAt: 1 });
export const PledgeTransaction = model('PledgeTransaction', pledgeTransactionSchema);