import mongoose from 'mongoose';
import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { DeskPrice } from '../desk/desk.models.js';
import { Security } from '../exchange/exchange.models.js';
import { Financer, Pledge, PledgeApplication, PledgeTransaction } from './pledge.models.js';
import { Lot } from './inventory.models.js';
import { Commodity } from './master.models.js';
import { Party } from './org.models.js';

const AUDIT_REALM = 'Cold';

/* ------------------------------------------------------------------ */
/* Exchange linkage helpers                                           */
/* ------------------------------------------------------------------ */

const EXCHANGE = 'exchange-price';
const REFERENCE = 'reference-price';
export type PriceSource = typeof EXCHANGE | typeof REFERENCE | 'unpriced';

export interface LivePrice {
  price: number;
  source: PriceSource;
  symbol: string | null;
  securityId: string | null;
}

/**
 * Resolve the live exchange price for a commodity's linked symbol.
 * Priority: latest DeskPrice (entered from the exchange feed) → Security.referencePrice.
 * Returns null when the commodity is not exchange-linked.
 */
export async function getLivePrice(input: { exchangeSymbol?: string | null; commodityId?: string | null }): Promise<LivePrice | null> {
  let symbol = input.exchangeSymbol ?? null;
  if (!symbol && input.commodityId) {
    const commodity = await Commodity.findOne({ commodityId: input.commodityId }).lean();
    symbol = commodity?.exchangeSymbol ?? null;
  }
  if (!symbol) return null;
  const upper = symbol.toUpperCase();
  const security = await Security.findOne({ symbol: upper, status: 'Listed' }).lean();
  const candidateInstrumentIds = [...new Set([security?.securityId, upper].filter((v): v is string => Boolean(v)))];
  const price = await DeskPrice.findOne({ instrumentId: { $in: candidateInstrumentIds } }).sort({ effectiveDate: -1, createdAt: -1 }).lean();
  if (price) return { price: price.price, source: EXCHANGE, symbol: upper, securityId: security?.securityId ?? null };
  if (security) return { price: security.referencePrice, source: REFERENCE, symbol: upper, securityId: security.securityId };
  return { price: 0, source: 'unpriced', symbol: upper, securityId: null };
}

/** Free (unpledged) quantity of a lot; pledged quantity is lien-held by financers. */
export function freeLotQuantity(lot: { currentQuantity: number; pledgedQuantity?: number }): number {
  return Number((Number(lot.currentQuantity) - Number(lot.pledgedQuantity ?? 0)).toFixed(10));
}

export function derivePledgeStatus(currentQuantity: number, pledgedQuantity: number): 'Unpledged' | 'PartiallyPledged' | 'FullyPledged' {
  if (pledgedQuantity <= 1e-9) return 'Unpledged';
  return pledgedQuantity >= currentQuantity - 1e-9 ? 'FullyPledged' : 'PartiallyPledged';
}

/** Throw PLEDGED_LOCK when `requestedQuantity` exceeds the unpledged free quantity. */
export function assertLienFree(lot: { lotId: string; currentQuantity: number; pledgedQuantity?: number }, requestedQuantity: number, context: string): void {
  const free = freeLotQuantity(lot);
  if (requestedQuantity > free + 1e-9) {
    throw new ApiError(409, `${context}: ${requestedQuantity} exceeds unpledged free stock of lot ${lot.lotId} (${free} free of ${lot.currentQuantity})`, 'PLEDGED_LOCK');
  }
}

/** Pledged-link summary for a party + symbol (used to block sell of pledged goods). */
export async function lienForInstrument(input: { symbol: string; partyId?: string | null }): Promise<{ pledgedQty: number; freeQty: number; commodityIds: string[] }> {
  if (!input.partyId) return { pledgedQty: 0, freeQty: Infinity, commodityIds: [] };
  const commodities = await Commodity.find({ exchangeSymbol: { $ne: null } }).select('commodityId exchangeSymbol').lean();
  const linked = commodities
    .filter((c) => String(c.exchangeSymbol).toUpperCase() === input.symbol.toUpperCase())
    .map((c) => c.commodityId);
  if (linked.length === 0) return { pledgedQty: 0, freeQty: Infinity, commodityIds: [] };
  const lots = await Lot.find({ ownerId: input.partyId, commodityId: { $in: linked }, status: { $in: ['Active', 'PartiallyWithdrawn'] } }).lean();
  const pledgedQty = lots.reduce((sum, lot) => sum + (lot.pledgedQuantity ?? 0), 0);
  const freeQty = lots.reduce((sum, lot) => sum + freeLotQuantity(lot), 0);
  return { pledgedQty, freeQty, commodityIds: linked };
}

/** Block a Sell of an exchange-linked instrument when the seller's pledged stock exceeds the order. */
export async function assertInstrumentSellFree(input: { symbol: string; partyId?: string | null; quantity: number }): Promise<void> {
  const lien = await lienForInstrument({ symbol: input.symbol, partyId: input.partyId });
  if (lien.commodityIds.length === 0 || lien.freeQty === Infinity) return;
  if (input.quantity > lien.freeQty + 1e-9) {
    throw new ApiError(409, `Sell blocked: ${input.quantity} exceeds unpledged free stock (${lien.freeQty}) — pledged goods cannot be traded`, 'PLEDGED_LOCK');
  }
}

/* ------------------------------------------------------------------ */
/* Financers (central admin manages the list)                          */
/* ------------------------------------------------------------------ */

export async function createFinancer(input: {
  organizationId?: string | null; name: string; financerType: string;
  contactPerson?: string; phone?: string; email?: string; address?: string; gstin?: string; pan?: string;
  maxLoanAmount?: number; minLoanAmount?: number; interestRatePct?: number; maxLtvPct?: number; tenureMonths?: number;
}, actorId: string): Promise<object> {
  const financerId = await nextId('financer');
  const financer = await Financer.create({ financerId, organizationId: input.organizationId ?? null, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'financers', recordId: financerId, action: 'Create', actorId, after: financer.toObject() });
  return financer.toObject();
}

export async function listFinancers(input: { organizationId?: string; status?: string }): Promise<object[]> {
  const filter: Record<string, unknown> = {};
  if (input.status) filter.status = input.status;
  if (input.organizationId) filter.$or = [{ organizationId: input.organizationId }, { organizationId: null }];
  return Financer.find(filter).sort({ name: 1 }).lean();
}

export async function updateFinancer(input: {
  financerId: string; name?: string; financerType?: string; contactPerson?: string; phone?: string; email?: string; address?: string;
  gstin?: string; pan?: string; maxLoanAmount?: number; minLoanAmount?: number; interestRatePct?: number; maxLtvPct?: number; tenureMonths?: number; status?: string;
}, actorId: string): Promise<object> {
  const financer = await Financer.findOne({ financerId: input.financerId });
  if (!financer) throw new ApiError(404, `Financer ${input.financerId} was not found`);
  const before = financer.toObject();
  for (const key of ['name', 'financerType', 'contactPerson', 'phone', 'email', 'address', 'gstin', 'pan', 'maxLoanAmount', 'minLoanAmount', 'interestRatePct', 'maxLtvPct', 'tenureMonths', 'status'] as const) {
    if (input[key] !== undefined) financer.set(key as string, input[key]);
  }
  await financer.save();
  await recordAudit({ realm: AUDIT_REALM, collection: 'financers', recordId: input.financerId, action: 'Update', actorId, before, after: financer.toObject() });
  return financer.toObject();
}

/* ------------------------------------------------------------------ */
/* Pledge applications (customer applies; financer reacts)             */
/* ------------------------------------------------------------------ */

export async function createPledgeApplication(input: {
  organizationId: string; facilityId: string; applicantPartyId: string; applicantUserId?: string | null;
  financerId?: string | null; lotId: string; quantity: number; unitId: string;
  stockValue: number; requestedAmount: number; requestedTenureMonths?: number; purpose?: string;
}, actorId: string): Promise<object> {
  const lot = await Lot.findOne({ lotId: input.lotId, organizationId: input.organizationId }).lean();
  if (!lot) throw new ApiError(404, `Lot ${input.lotId} was not found`);
  if (lot.ownerId !== input.applicantPartyId) throw new ApiError(403, 'You can only pledge lots you own', 'NOT_OWNER');
  if (input.quantity > lot.currentQuantity) throw new ApiError(400, 'Pledged quantity exceeds available stock');
  // The requested quantity must be free (not already pledged under an earlier loan).
  assertLienFree(lot, input.quantity, 'Pledge application');
  if (input.requestedAmount > input.stockValue) throw new ApiError(400, 'Requested amount cannot exceed stock value');

  const applicationId = await nextId('pledgeApplication');
  const application = await PledgeApplication.create({
    applicationId, organizationId: input.organizationId, facilityId: input.facilityId,
    applicantPartyId: input.applicantPartyId, applicantUserId: input.applicantUserId ?? null,
    financerId: input.financerId ?? null, lotId: input.lotId, commodityId: lot.commodityId,
    quantity: input.quantity, unitId: input.unitId, stockValue: input.stockValue,
    requestedAmount: input.requestedAmount, requestedTenureMonths: input.requestedTenureMonths ?? 12,
    purpose: input.purpose ?? '', status: 'Submitted'
  });
  await recordAudit({ realm: AUDIT_REALM, collection: 'pledgeApplications', recordId: applicationId, action: 'Submit', actorId, metadata: input });
  return application.toObject();
}

export async function listPledgeApplications(input: {
  organizationId?: string; applicantPartyId?: string; financerId?: string; status?: string; page?: number; limit?: number;
}): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = {};
  if (input.organizationId) filter.organizationId = input.organizationId;
  if (input.applicantPartyId) filter.applicantPartyId = input.applicantPartyId;
  if (input.financerId) filter.financerId = input.financerId;
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    PledgeApplication.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PledgeApplication.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

/** Financer reacts to an application: approve (creates a pledge) or reject. */
export async function reactToApplication(input: {
  applicationId: string; financerId: string; decision: 'Approved' | 'Rejected';
  approvedAmount?: number; interestRatePct?: number; tenureMonths?: number; reason?: string;
}, actorId: string): Promise<object> {
  const application = await PledgeApplication.findOne({ applicationId: input.applicationId });
  if (!application) throw new ApiError(404, `Application ${input.applicationId} was not found`);
  if (application.status !== 'Submitted' && application.status !== 'UnderReview') {
    throw new ApiError(409, `Application is ${application.status}, cannot react`);
  }
  if (application.financerId && application.financerId !== input.financerId) {
    throw new ApiError(403, 'This application is not addressed to you', 'NOT_YOUR_APPLICATION');
  }

  if (input.decision === 'Rejected') {
    application.status = 'Rejected';
    application.statusReason = input.reason ?? 'Declined by financer';
    application.reviewedByFinancerId = input.financerId;
    application.reviewedAt = new Date();
    await application.save();
    await recordAudit({ realm: AUDIT_REALM, collection: 'pledgeApplications', recordId: input.applicationId, action: 'Reject', actorId, metadata: input });
    return application.toObject();
  }

  const financer = await Financer.findOne({ financerId: input.financerId }).lean();
  if (!financer) throw new ApiError(404, `Financer ${input.financerId} was not found`);
  const lot = await Lot.findOne({ lotId: application.lotId }).lean();
  if (!lot) throw new ApiError(404, `Lot ${application.lotId} was not found`);
  // The quantity being pledged must be free (not already pledged under another pledge).
  assertLienFree(lot, application.quantity, 'Pledge approval');

  const loanAmount = input.approvedAmount ?? application.requestedAmount;
  const interestRatePct = input.interestRatePct ?? financer.interestRatePct ?? 0;
  const tenureMonths = input.tenureMonths ?? application.requestedTenureMonths ?? financer.tenureMonths ?? 12;
  const ltvPct = Math.round((loanAmount / application.stockValue) * 1000) / 10;
  if (ltvPct > (financer.maxLtvPct ?? 70)) {
    throw new ApiError(400, `Loan amount exceeds financer max LTV of ${financer.maxLtvPct}%`, 'LTV_EXCEEDED');
  }

  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      // Re-check lien free under the session (prevents two approvals racing on one lot).
      const locked = await Lot.findOne({ lotId: application.lotId, organizationId: application.organizationId }).session(session);
      if (!locked) throw new ApiError(404, `Lot ${application.lotId} was not found`);
      assertLienFree(locked, application.quantity, 'Pledge approval');
      // Reserve the pledged quantity on the lot: lien held by the financer.
      locked.pledgedQuantity = Number((Number(locked.pledgedQuantity ?? 0) + application.quantity).toFixed(10));
      locked.pledgeStatus = derivePledgeStatus(locked.currentQuantity, locked.pledgedQuantity);
      locked.statusReason = locked.pledgeStatus === 'FullyPledged' ? 'Lot fully pledged as loan security' : (locked.pledgeStatus === 'PartiallyPledged' ? 'Part of lot pledged as loan security' : locked.statusReason);
      await locked.save({ session });

      const pledgeId = await nextId('pledge');
      const dueDate = new Date();
      dueDate.setMonth(dueDate.getMonth() + tenureMonths);
      const pledgedPrice = application.quantity > 0 ? application.stockValue / application.quantity : 0;
      const [pledge] = await Pledge.create([{
        pledgeId, applicationId: application.applicationId, organizationId: application.organizationId,
        facilityId: application.facilityId, lotId: application.lotId,
        borrowerPartyId: application.applicantPartyId, financerId: input.financerId,
        loanAmount, interestRatePct, tenureMonths, ltvPct, stockValue: application.stockValue,
        pledgedQuantity: application.quantity, unitId: application.unitId,
        disbursedAt: new Date(), dueDate, status: 'Active',
        pledgedPrice, linkedSymbol: null, marginCallStatus: 'Exempt', marginCallThresholdPct: 80
      }], { session });
      await PledgeTransaction.create([{
        transactionId: await nextId('pledgeTransaction'), pledgeId, organizationId: application.organizationId,
        facilityId: application.facilityId, type: 'Disbursement', amount: loanAmount,
        narration: `Loan disbursed against ${application.lotId}`, actorId
      }], { session });
      application.status = 'Approved';
      application.statusReason = input.reason ?? '';
      application.reviewedByFinancerId = input.financerId;
      application.reviewedAt = new Date();
      await application.save({ session });
      result = pledge!.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'pledges', recordId: String((result as { pledgeId?: string }).pledgeId ?? ''), action: 'Approve & Disburse', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Pledges (active loans)                                              */
/* ------------------------------------------------------------------ */

export async function listPledges(input: {
  organizationId?: string; borrowerPartyId?: string; financerId?: string; status?: string; page?: number; limit?: number;
}): Promise<{ items: object[]; total: number; page: number; limit: number }> {
  const filter: Record<string, unknown> = {};
  if (input.organizationId) filter.organizationId = input.organizationId;
  if (input.borrowerPartyId) filter.borrowerPartyId = input.borrowerPartyId;
  if (input.financerId) filter.financerId = input.financerId;
  if (input.status) filter.status = input.status;
  const page = Math.max(1, input.page ?? 1);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const [items, total] = await Promise.all([
    Pledge.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Pledge.countDocuments(filter)
  ]);
  return { items, total, page, limit };
}

export async function getPledge(pledgeId: string): Promise<object> {
  const pledge = await Pledge.findOne({ pledgeId }).lean();
  if (!pledge) throw new ApiError(404, `Pledge ${pledgeId} was not found`);
  const transactions = await PledgeTransaction.find({ pledgeId }).sort({ createdAt: 1 }).lean();
  const lot = await Lot.findOne({ lotId: pledge.lotId }).lean();
  const party = await Party.findOne({ partyId: pledge.borrowerPartyId }).lean();
  const financer = await Financer.findOne({ financerId: pledge.financerId }).lean();
  return { pledge, transactions, lot, party, financer };
}

/** Accrue simple interest on a pledge (daily rate × days since last accrual). */
export async function accrueInterest(input: { pledgeId: string }, actorId: string): Promise<object> {
  const pledge = await Pledge.findOne({ pledgeId: input.pledgeId });
  if (!pledge) throw new ApiError(404, `Pledge ${input.pledgeId} was not found`);
  if (pledge.status !== 'Active') throw new ApiError(409, `Pledge is ${pledge.status}, cannot accrue`);

  const lastTx = await PledgeTransaction.findOne({ pledgeId: input.pledgeId, type: 'InterestAccrual' }).sort({ createdAt: -1 }).lean();
  const lastAccrual = lastTx?.createdAt ?? pledge.disbursedAt ?? pledge.createdAt;
  const days = Math.max(0, Math.floor((Date.now() - new Date(lastAccrual).getTime()) / (24 * 60 * 60 * 1000)));
  if (days === 0) return { pledgeId: input.pledgeId, accrued: 0, days };

  const dailyRate = pledge.interestRatePct / 100 / 365;
  const accrued = Math.round(pledge.loanAmount * dailyRate * days * 100) / 100;
  const transaction = await PledgeTransaction.create({
    transactionId: await nextId('pledgeTransaction'), pledgeId: input.pledgeId,
    organizationId: pledge.organizationId, facilityId: pledge.facilityId,
    type: 'InterestAccrual', amount: accrued, interestRatePct: pledge.interestRatePct,
    daysAccrued: days, narration: `Interest accrued for ${days} days`, actorId
  });
  await recordAudit({ realm: AUDIT_REALM, collection: 'pledgeTransactions', recordId: transaction.transactionId, action: 'Accrue Interest', actorId });
  return { pledgeId: input.pledgeId, accrued, days, transactionId: transaction.transactionId };
}

/** Repay principal and/or interest on a pledge. */
export async function repayPledge(input: {
  pledgeId: string; principalAmount?: number; interestAmount?: number; narration?: string;
}, actorId: string): Promise<object> {
  const pledge = await Pledge.findOne({ pledgeId: input.pledgeId });
  if (!pledge) throw new ApiError(404, `Pledge ${input.pledgeId} was not found`);
  if (pledge.status !== 'Active') throw new ApiError(409, `Pledge is ${pledge.status}, cannot repay`);

  const principalAmount = input.principalAmount ?? 0;
  const interestAmount = input.interestAmount ?? 0;
  if (principalAmount <= 0 && interestAmount <= 0) throw new ApiError(400, 'Provide a repayment amount');
  if (principalAmount > pledge.loanAmount - pledge.principalPaid) throw new ApiError(400, 'Principal repayment exceeds outstanding principal');

  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      if (principalAmount > 0) {
        await PledgeTransaction.create([{
          transactionId: await nextId('pledgeTransaction'), pledgeId: input.pledgeId,
          organizationId: pledge.organizationId, facilityId: pledge.facilityId,
          type: 'RepaymentPrincipal', amount: principalAmount, narration: input.narration ?? 'Principal repayment', actorId
        }], { session });
      }
      if (interestAmount > 0) {
        await PledgeTransaction.create([{
          transactionId: await nextId('pledgeTransaction'), pledgeId: input.pledgeId,
          organizationId: pledge.organizationId, facilityId: pledge.facilityId,
          type: 'RepaymentInterest', amount: interestAmount, narration: input.narration ?? 'Interest repayment', actorId
        }], { session });
      }
      pledge.principalPaid += principalAmount;
      pledge.interestPaid += interestAmount;
      pledge.lastPaymentAt = new Date();
      if (pledge.principalPaid >= pledge.loanAmount - 0.01) {
        pledge.status = 'Closed';
        pledge.closedAt = new Date();
        pledge.statusReason = 'Fully repaid';
        await PledgeTransaction.create([{
          transactionId: await nextId('pledgeTransaction'), pledgeId: input.pledgeId,
          organizationId: pledge.organizationId, facilityId: pledge.facilityId,
          type: 'Closure', amount: 0, narration: 'Pledge closed after full repayment', actorId
        }], { session });
        // Clear the lien on the lot: fully repaid → no pledge remains on that stock.
        await recomputeLotLien(pledge.lotId, { session, excludePledgeId: pledge.pledgeId, remainingLien: 0 });
      }
      await pledge.save({ session });
      result = pledge.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'pledges', recordId: input.pledgeId, action: 'Repay', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Release pledged stock (partial or full) after repayment. */
export async function releasePledgeStock(input: { pledgeId: string; quantity: number }, actorId: string): Promise<object> {
  const pledge = await Pledge.findOne({ pledgeId: input.pledgeId });
  if (!pledge) throw new ApiError(404, `Pledge ${input.pledgeId} was not found`);
  if (pledge.status !== 'Active') throw new ApiError(409, `Pledge is ${pledge.status}, cannot release`);
  if (input.quantity <= 0) throw new ApiError(400, 'Release quantity must be positive');
  if (pledge.releasedQuantity + input.quantity > pledge.pledgedQuantity) throw new ApiError(400, 'Release exceeds pledged quantity');

  const session = await mongoose.startSession();
  try {
    let result: object = {};
    await session.withTransaction(async () => {
      const beforeStatus = pledge.status;
      pledge.releasedQuantity += input.quantity;
      if (pledge.releasedQuantity > 0 && pledge.releasedQuantity < pledge.pledgedQuantity - 0.001) {
        pledge.status = 'PartiallyReleased';
      } else if (pledge.releasedQuantity >= pledge.pledgedQuantity - 0.001) {
        pledge.status = 'Closed';
        pledge.closedAt = new Date();
        pledge.statusReason = 'All pledged stock released';
      }
      await PledgeTransaction.create([{
        transactionId: await nextId('pledgeTransaction'), pledgeId: input.pledgeId,
        organizationId: pledge.organizationId, facilityId: pledge.facilityId,
        type: 'Release', amount: 0, quantity: input.quantity,
        narration: `Released ${input.quantity} units of pledged stock`, actorId
      }], { session });
      // Full release (or full pledge repay) clears the whole lien; partial release frees
      // only the released quantity (the balance stays pledged under this pledge).
      await recomputeLotLien(pledge.lotId, {
        session,
        excludePledgeId: pledge.pledgeId,
        remainingLien: pledge.status === 'Closed' ? 0 : Math.max(0, pledge.pledgedQuantity - pledge.releasedQuantity)
      });
      if (beforeStatus === 'Active' && pledge.status === 'PartiallyReleased') {
        await refreshPledgeValuation(pledge.pledgeId, actorId, session);
      }
      await pledge.save({ session });
      result = pledge.toObject();
    });
    await recordAudit({ realm: AUDIT_REALM, collection: 'pledges', recordId: input.pledgeId, action: 'Release Stock', actorId, metadata: input });
    return result;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------------ */
/* Lot lien helpers (shared with inventory service)                    */
/* ------------------------------------------------------------------ */

/**
 * Recompute the pledged-quantity lock on a lot from its live (active or
 * partially released) pledges. The lot's lien equals the sum of pledged
 * quantity still outstanding on that lot. Call after repay/release/closure.
 *
 * When the calling pledge is mid-transaction (mutated in memory, not flushed),
 * pass `excludePledgeId` to exclude its stale DB document and `remainingLien`
 * for its in-memory outstanding qty (0 when the pledge is being closed).
 */
export async function recomputeLotLien(lotId: string, options: { session?: mongoose.ClientSession; excludePledgeId?: string; remainingLien?: number } = {}): Promise<void> {
  const lot = await Lot.findOne({ lotId }).session(options.session ?? null);
  if (!lot) return;
  const activeFilter: Record<string, unknown> = { lotId, status: { $in: ['Active', 'PartiallyReleased'] } };
  if (options.excludePledgeId) activeFilter.pledgeId = { $ne: options.excludePledgeId };
  const active = await Pledge.find(activeFilter).select('pledgedQuantity releasedQuantity').session(options.session ?? null).lean();
  const otherLien = active.reduce((sum, p) => sum + (Number(p.pledgedQuantity) - Number(p.releasedQuantity)), 0);
  const lien = otherLien + (options.excludePledgeId ? (options.remainingLien ?? 0) : 0);
  lot.pledgedQuantity = Math.max(0, Number(lien.toFixed(10)));
  lot.pledgeStatus = derivePledgeStatus(lot.currentQuantity, lot.pledgedQuantity);
  if (lot.pledgeStatus === 'Unpledged') lot.statusReason = '';
  await lot.save({ session: options.session ?? null });
}

/* ------------------------------------------------------------------ */
/* Margin-call valuation (exchange-linked price)                       */
/* ------------------------------------------------------------------ */

/**
 * Revalue a pledge against the live exchange price of its linked symbol and
 * set its margin-call status. Returns the ledger entry created (or null when
 * the pledge is not exchange-linked → stays Exempt).
 */
export async function refreshPledgeValuation(pledgeId: string, actorId: string, session?: mongoose.ClientSession): Promise<{ pledge: InstanceType<typeof Pledge>; transaction?: InstanceType<typeof PledgeTransaction>; live?: LivePrice } | null> {
  const pledge = await Pledge.findOne({ pledgeId }).session(session ?? null);
  if (!pledge) throw new ApiError(404, `Pledge ${pledgeId} was not found`);
  if (!['Active', 'PartiallyReleased'].includes(pledge.status)) return { pledge, live: undefined };

  const lot = await Lot.findOne({ lotId: pledge.lotId }).session(session ?? null).lean();
  const commodity = lot ? await Commodity.findOne({ commodityId: lot.commodityId }).lean() : null;
  const live = await getLivePrice({ exchangeSymbol: commodity?.exchangeSymbol ?? null });
  if (!live) {
    // Not exchange-linked: exempt from live margin monitoring.
    pledge.marginCallStatus = 'Exempt';
    pledge.linkedSymbol = null;
    await pledge.save({ session: session ?? null });
    return { pledge, live: undefined };
  }
  if (live.source === 'unpriced' || live.price <= 0) {
    pledge.marginCallStatus = 'Exempt';
    pledge.linkedSymbol = live.symbol;
    await pledge.save({ session: session ?? null });
    return { pledge, live };
  }

  const outstanding = Number(pledge.loanAmount) - Number(pledge.principalPaid);
  const currentValue = Number(pledge.pledgedQuantity) * live.price;
  const currentLtvPct = currentValue > 1e-9 ? Math.round((outstanding / currentValue) * 1000) / 10 : 0;
  const threshold = Number(pledge.marginCallThresholdPct ?? 80);
  let status: typeof pledge.marginCallStatus = 'Healthy';
  if (currentLtvPct >= 100) status = 'Default';
  else if (currentLtvPct >= threshold) status = 'MarginCall';
  else if (currentLtvPct >= threshold - 10) status = 'Warning';
  const changed = status !== pledge.marginCallStatus;

  pledge.linkedSymbol = live.symbol;
  pledge.lastValuationPrice = live.price;
  pledge.lastValuationLtvPct = currentLtvPct;
  pledge.lastValuationAt = new Date();
  pledge.marginCallStatus = status;
  if (status === 'Default') {
    pledge.statusReason = `Collateral value below loan — LTV ${currentLtvPct}%`;
  } else if (pledge.statusReason.startsWith('Collateral value below loan')) {
    pledge.statusReason = '';
  }
  await pledge.save({ session: session ?? null });

  const transaction = await PledgeTransaction.create([{
    transactionId: await nextId('pledgeTransaction'), pledgeId, organizationId: pledge.organizationId,
    facilityId: pledge.facilityId, type: changed && status !== 'Healthy' && status !== 'Warning' ? 'MarginCall' : 'Valuation',
    amount: 0, narration: `${status} — live ${live.symbol} @ ${live.price} (LTV ${currentLtvPct}%)${changed && status !== 'Healthy' && status !== 'Warning' ? ' — MARGIN CALL' : ''}`, actorId
  }], { session: session ?? null });

  await recordAudit({ realm: AUDIT_REALM, collection: 'pledges', recordId: pledgeId, action: changed ? 'Margin Call' : 'Valuation', actorId, metadata: { pledgeId, live: { ...live, currentLtvPct, status } } });
  return { pledge, transaction: transaction[0]!, live };
}

/** Revalue every active pledge across an organization (or network when organizationId is null). */
export async function refreshAllPledges(input: { organizationId?: string | null; financerId?: string | null }, actorId: string): Promise<{ refreshed: number; marginCalls: number; exempt: number; items: Array<Record<string, unknown>> }> {
  const filter: Record<string, unknown> = { status: { $in: ['Active', 'PartiallyReleased'] } };
  if (input.organizationId) filter.organizationId = input.organizationId;
  if (input.financerId) filter.financerId = input.financerId;
  const pledges = await Pledge.find(filter).lean();
  const results: Array<{ pledgeId: string; marginCallStatus: string; currentLtvPct: number | null; lastValuationPrice: number | null }> = [];
  let marginCalls = 0;
  let exempt = 0;
  for (const pledge of pledges) {
    const result = await refreshPledgeValuation(pledge.pledgeId, actorId);
    if (!result) continue;
    results.push({
      pledgeId: pledge.pledgeId,
      marginCallStatus: result.pledge.marginCallStatus,
      currentLtvPct: result.pledge.lastValuationLtvPct ?? null,
      lastValuationPrice: result.pledge.lastValuationPrice ?? null
    });
    if (['MarginCall', 'Default'].includes(result.pledge.marginCallStatus)) marginCalls += 1;
    if (result.pledge.marginCallStatus === 'Exempt') exempt += 1;
  }
  return { refreshed: results.length, marginCalls, exempt, items: results };
}