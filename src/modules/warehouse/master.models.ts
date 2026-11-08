import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/* ------------------------------------------------------------------ */
/* Units of measurement & explicit conversions                          */
/* ------------------------------------------------------------------ */

const unitSchema = new Schema({
  unitId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  code: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, enum: ['Count', 'Weight', 'Volume'], required: true },
  // Conversions are explicit: e.g. 1 bag = 50 kg; invalid pairs are never silently converted.
  baseWeightKg: { type: Number, default: null }, // null where not applicable
  conversions: [{
    toUnitId: { type: String, required: true },
    factor: { type: Number, required: true, min: 0.000000001 }
  }]
}, options);
unitSchema.index({ organizationId: 1, code: 1 }, { unique: true });
export const Unit = model('Unit', unitSchema);

/* ------------------------------------------------------------------ */
/* Commodities & varieties                                              */
/* ------------------------------------------------------------------ */

const commoditySchema = new Schema({
  commodityId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  commodityCode: { type: String, default: '' },
  defaultUnitId: { type: String, default: null },
  category: { type: String, default: '' },
  isPerishable: { type: Boolean, default: true },
  requiresFumigation: { type: Boolean, default: false },
  idealStorageTempC: { type: Number, default: null },
  moistureMinPct: { type: Number, default: null },
  moistureMaxPct: { type: Number, default: null },
  // Link to the exchange: the symbol that this commodity trades as (e.g. 'AGORA').
  // When set, pledged stock of this commodity is valued at the live exchange price
  // and its lots are blocked from the trading/settlement flows.
  exchangeSymbol: { type: String, default: null, index: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
commoditySchema.index({ organizationId: 1, name: 1 }, { unique: true });
export const Commodity = model('Commodity', commoditySchema);

const varietySchema = new Schema({
  varietyId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  commodityId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  grade: { type: String, default: '' }
}, options);
varietySchema.index({ organizationId: 1, commodityId: 1, name: 1 }, { unique: true });
export const Variety = model('Variety', varietySchema);

/* ------------------------------------------------------------------ */
/* Packaging / bag types                                               */
/* ------------------------------------------------------------------ */

const packagingSchema = new Schema({
  packagingId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  unitId: { type: String, required: true },
  // e.g. one bag = 50 kg; one carton = 20 kg; one pallet = 40 bags
  itemsPerHandlingUnit: { type: Number, default: null },
  weightPerItemKg: { type: Number, default: null },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
export const Packaging = model('Packaging', packagingSchema);

/* ------------------------------------------------------------------ */
/* Storage locations: shed -> chamber -> rack/slot                     */
/* ------------------------------------------------------------------ */

export const LOCATION_TYPES = ['Shed', 'Chamber', 'Rack', 'Slot', 'OpenArea'] as const;

const locationSchema = new Schema({
  locationId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  parentLocationId: { type: String, default: null, index: true },
  type: { type: String, enum: LOCATION_TYPES, required: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true },
  capacityBags: { type: Number, default: 0 },
  capacityKg: { type: Number, default: 0 },
  // capacity model is configurable: bags-capacity vs kg-capacity vs both
  capacityModel: { type: String, enum: ['Bags', 'Weight', 'BagsAndWeight'], default: 'Bags' },
  reservedKg: { type: Number, default: 0 },
  unavailableKg: { type: Number, default: 0 },
  minTempC: { type: Number, default: null },
  maxTempC: { type: Number, default: null },
  handlerType: { type: String, default: 'roto', enum: ['roto', 'conventional', 'ambient', 'open'] },
  status: { type: String, enum: ['Active', 'Inactive', 'Maintenance'], default: 'Active' }
}, options);
locationSchema.index({ facilityId: 1, code: 1 }, { unique: true });
export const StorageLocation = model('StorageLocation', locationSchema);

const palletSchema = new Schema({
  palletId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  locationId: { type: String, default: null, index: true },
  code: { type: String, required: true, trim: true },
  capacityBags: { type: Number, default: 0 },
  status: { type: String, enum: ['Empty', 'InUse', 'Reserved', 'Maintenance'], default: 'Empty' }
}, options);
export const Pallet = model('Pallet', palletSchema);

/* ------------------------------------------------------------------ */
/* Charge types & billing rules (configurable per facility)            */
/* ------------------------------------------------------------------ */

export const CHARGE_BASES = ['quantity', 'weight', 'bags', 'pallets', 'duration', 'contract'] as const;
export const BILL_TYPES = ['Storage', 'HandlingInward', 'HandlingOutward', 'Loading', 'Unloading', 'Transport', 'Packaging', 'Service', 'Other'] as const;

const chargeTypeSchema = new Schema({
  chargeTypeId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  billType: { type: String, enum: BILL_TYPES, required: true },
  base: { type: String, enum: CHARGE_BASES, required: true },
  rate: { type: Number, default: 0 },           // currency per base unit
  unitId: { type: String, default: null },       // required when base in quantity/weight
  taxRatePct: { type: Number, default: 0 },
  freeDays: { type: Number, default: 0 },
  minimumPeriodDays: { type: Number, default: 1 },
  partialDayRule: { type: String, enum: ['chargeFullDay', 'prorate', 'roundUpHalfDay'], default: 'chargeFullDay' },
  roundingRule: { type: String, enum: ['none', 'round', 'ceil', 'floor'], default: 'none' },
  // contract rule: JSON blob evaluated by service, e.g. slab rates
  ruleConfig: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
export const ChargeType = model('ChargeType', chargeTypeSchema);

/* ------------------------------------------------------------------ */
/* Chart of accounts (double-entry)                                    */
/* ------------------------------------------------------------------ */

export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'] as const;

const accountSchema = new Schema({
  accountId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  code: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  accountType: { type: String, enum: ACCOUNT_TYPES, required: true },
  isDefault: { type: Boolean, default: false },
  parentAccountId: { type: String, default: null },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' }
}, options);
accountSchema.index({ organizationId: 1, code: 1 }, { unique: true });
export const Account = model('Account', accountSchema);
