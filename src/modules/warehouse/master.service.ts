import { ApiError } from '../../common/errors.js';
import { nextId } from '../../common/ids.js';
import { recordAudit } from '../audit/audit.service.js';
import { Account, ChargeType, Commodity, Packaging, Pallet, StorageLocation, Unit, Variety } from './master.models.js';
import { requireFacilityInOrg } from './scoping.js';

const AUDIT_REALM = 'Storage';

/* ------------------------------------------------------------------ */
/* Units                                                               */
/* ------------------------------------------------------------------ */

export async function createUnit(input: { organizationId: string; code: string; name: string; category: string; baseWeightKg?: number | null; conversions?: Array<{ toUnitId: string; factor: number }> }, actorId: string): Promise<object> {
  const unitId = await nextId('unit');
  const unit = await Unit.create({ unitId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'units', recordId: unitId, action: 'Create', actorId, after: unit.toObject() });
  return unit.toObject();
}

export async function listUnits(organizationId: string): Promise<object[]> {
  return Unit.find({ organizationId }).sort({ code: 1 }).lean();
}

/** Converts a quantity from one unit to another, or null if not convertible. Never silently converts. */
export async function tryConvert(organizationId: string, fromUnitId: string, toUnitId: string, quantity: number): Promise<number | null> {
  if (fromUnitId === toUnitId) return quantity;
  const [fromUnit, toUnit] = await Promise.all([Unit.findOne({ unitId: fromUnitId }).lean(), Unit.findOne({ unitId: toUnitId }).lean()]);
  if (!fromUnit || !toUnit) return null;
  if (fromUnit.baseWeightKg && toUnit.baseWeightKg) return (quantity * fromUnit.baseWeightKg) / toUnit.baseWeightKg;
  const direct = fromUnit.conversions.find((c) => c.toUnitId === toUnitId);
  if (direct) return quantity * direct.factor;
  return null;
}

/* ------------------------------------------------------------------ */
/* Commodities & varieties                                             */
/* ------------------------------------------------------------------ */

export async function createCommodity(input: { organizationId: string; name: string; commodityCode?: string; defaultUnitId?: string; isPerishable?: boolean; idealStorageTempC?: number | null; moistureMinPct?: number | null; moistureMaxPct?: number | null; exchangeSymbol?: string | null }, actorId: string): Promise<object> {
  const commodityId = await nextId('commodity');
  const commodity = await Commodity.create({ commodityId, ...input, exchangeSymbol: input.exchangeSymbol ? input.exchangeSymbol.toUpperCase() : null });
  await recordAudit({ realm: AUDIT_REALM, collection: 'commodities', recordId: commodityId, action: 'Create', actorId, after: commodity.toObject() });
  return commodity.toObject();
}

export async function listCommodities(organizationId: string): Promise<object[]> {
  return Commodity.find({ organizationId, status: 'Active' }).sort({ name: 1 }).lean();
}

export async function updateCommodity(input: {
  commodityId: string; name?: string; commodityCode?: string; defaultUnitId?: string | null;
  isPerishable?: boolean; idealStorageTempC?: number | null; moistureMinPct?: number | null;
  moistureMaxPct?: number | null; exchangeSymbol?: string | null;
}, actorId: string): Promise<object> {
  const commodity = await Commodity.findOne({ commodityId: input.commodityId });
  if (!commodity) throw new ApiError(404, `Commodity ${input.commodityId} was not found`);
  const before = commodity.toObject();
  for (const key of ['name', 'commodityCode', 'defaultUnitId', 'isPerishable', 'idealStorageTempC', 'moistureMinPct', 'moistureMaxPct'] as const) {
    if (input[key] !== undefined) commodity.set(key as string, input[key]);
  }
  if (input.exchangeSymbol !== undefined) commodity.set('exchangeSymbol', input.exchangeSymbol ? input.exchangeSymbol.toUpperCase() : null);
  await commodity.save();
  await recordAudit({ realm: AUDIT_REALM, collection: 'commodities', recordId: input.commodityId, action: 'Update', actorId, before, after: commodity.toObject() });
  return commodity.toObject();
}

export async function createVariety(input: { organizationId: string; commodityId: string; name: string; grade?: string }, actorId: string): Promise<object> {
  const varietyId = await nextId('variety');
  const variety = await Variety.create({ varietyId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'varieties', recordId: varietyId, action: 'Create', actorId, after: variety.toObject() });
  return variety.toObject();
}

export async function listVarieties(organizationId: string, commodityId?: string): Promise<object[]> {
  const filter: Record<string, unknown> = { organizationId };
  if (commodityId) filter.commodityId = commodityId;
  return Variety.find(filter).sort({ name: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Packaging                                                           */
/* ------------------------------------------------------------------ */

export async function createPackaging(input: { organizationId: string; name: string; unitId: string; itemsPerHandlingUnit?: number | null; weightPerItemKg?: number | null }, actorId: string): Promise<object> {
  const packagingId = await nextId('packaging');
  const packaging = await Packaging.create({ packagingId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'packagings', recordId: packagingId, action: 'Create', actorId, after: packaging.toObject() });
  return packaging.toObject();
}

export async function listPackagings(organizationId: string): Promise<object[]> {
  return Packaging.find({ organizationId, status: 'Active' }).sort({ name: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Storage locations                                                   */
/* ------------------------------------------------------------------ */

export async function createStorageLocation(input: {
  organizationId: string; facilityId: string; type: string; name: string; code: string;
  parentLocationId?: string | null; capacityBags?: number; capacityKg?: number; capacityModel?: string;
  handlerType?: string; minTempC?: number | null; maxTempC?: number | null;
}, actorId: string): Promise<object> {
  await requireFacilityInOrg(input.organizationId, input.facilityId);
  const locationId = await nextId('location');
  const location = await StorageLocation.create({ locationId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'storageLocations', recordId: locationId, action: 'Create', actorId, after: location.toObject() });
  return location.toObject();
}

export async function listStorageLocations(facilityId: string): Promise<object[]> {
  return StorageLocation.find({ facilityId }).sort({ name: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Pallets                                                            */
/* ------------------------------------------------------------------ */

export async function createPallet(input: { organizationId: string; facilityId: string; locationId?: string | null; code: string; capacityBags?: number }, actorId: string): Promise<object> {
  const palletId = await nextId('pallet');
  const pallet = await Pallet.create({ palletId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'pallets', recordId: palletId, action: 'Create', actorId, after: pallet.toObject() });
  return pallet.toObject();
}

export async function listPallets(facilityId: string): Promise<object[]> {
  return Pallet.find({ facilityId }).sort({ code: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Charge types                                                        */
/* ------------------------------------------------------------------ */

export async function createChargeType(input: {
  organizationId: string; facilityId: string; name: string; billType: string; base: string;
  rate?: number; unitId?: string | null; taxRatePct?: number; freeDays?: number; minimumPeriodDays?: number;
  partialDayRule?: string; roundingRule?: string; ruleConfig?: unknown;
}, actorId: string): Promise<object> {
  await requireFacilityInOrg(input.organizationId, input.facilityId);
  const chargeTypeId = await nextId('chargeType');
  const chargeType = await ChargeType.create({ chargeTypeId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'chargeTypes', recordId: chargeTypeId, action: 'Create', actorId, after: chargeType.toObject() });
  return chargeType.toObject();
}

export async function listChargeTypes(facilityId: string): Promise<object[]> {
  return ChargeType.find({ facilityId, status: 'Active' }).sort({ name: 1 }).lean();
}

/* ------------------------------------------------------------------ */
/* Chart of accounts                                                   */
/* ------------------------------------------------------------------ */

export async function createAccount(input: { organizationId: string; code: string; name: string; accountType: string; isDefault?: boolean; parentAccountId?: string | null }, actorId: string): Promise<object> {
  const accountId = await nextId('account');
  const account = await Account.create({ accountId, ...input });
  await recordAudit({ realm: AUDIT_REALM, collection: 'accounts', recordId: accountId, action: 'Create', actorId, after: account.toObject() });
  return account.toObject();
}

export async function listAccounts(organizationId: string): Promise<object[]> {
  return Account.find({ organizationId, status: 'Active' }).sort({ code: 1 }).lean();
}

export async function assertAccountExists(organizationId: string, accountId: string): Promise<void> {
  const account = await Account.findOne({ accountId, organizationId }).lean();
  if (!account) throw new ApiError(404, `Account ${accountId} was not found`);
}
