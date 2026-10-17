import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

const mandiSchema = new Schema({
  mandiId: { type: String, required: true, unique: true }, code: { type: String, required: true, unique: true, uppercase: true },
  name: { type: String, required: true }, region: { type: String, default: '' }, currency: { type: String, required: true, uppercase: true },
  timezone: { type: String, required: true, default: 'UTC' }, status: { type: String, enum: ['Active', 'Halted', 'Closed'], default: 'Active' },
  statusReason: { type: String, default: '' }, openedOn: { type: Date, default: Date.now }
}, options);
export const Mandi = model('Mandi', mandiSchema);

const instrumentSchema = new Schema({
  instrumentId: { type: String, required: true, unique: true }, name: { type: String, required: true }, isin: { type: String, default: '' },
  assetType: { type: String, required: true }, sector: { type: String, default: '' }, currency: { type: String, required: true, uppercase: true },
  issuer: { type: String, default: '' }, issueDate: Date, faceValue: { type: Number, min: 0, default: 0 }
}, options);
export const Instrument = model('Instrument', instrumentSchema);

const securitySchema = new Schema({
  securityId: { type: String, required: true, unique: true }, instrumentId: { type: String, required: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true }, mandiId: { type: String, required: true, index: true },
  status: { type: String, enum: ['Listed', 'Suspended', 'Delisted'], required: true, default: 'Listed' }, statusReason: { type: String, default: '' },
  tickSize: { type: Number, required: true, min: 0.00000001 }, lotSize: { type: Number, required: true, min: 0.00000001 },
  priceBandPct: { type: Number, required: true, min: 0 }, referencePrice: { type: Number, required: true, min: 0.00000001 },
  referenceIsSeeded: { type: Boolean, default: true }, settlementDays: { type: Number, required: true, min: 0, default: 2 },
  forwardPremium: { type: Number, default: 0 }, lotWeight: { type: Number, min: 0, default: 0 },
  depositoryId: { type: String, required: true }, listedDate: { type: Date, default: Date.now }
}, options);
securitySchema.index({ mandiId: 1, symbol: 1 }, { unique: true });
export const Security = model('Security', securitySchema);

const memberSchema = new Schema({
  brokerId: { type: String, required: true, unique: true }, code: { type: String, required: true, unique: true, uppercase: true }, name: { type: String, required: true },
  mandiId: { type: String, required: true, index: true }, status: { type: String, enum: ['Active', 'Suspended', 'Terminated'], default: 'Active' },
  contactEmail: { type: String, default: '' }, apiKeyHash: { type: String, required: true, select: false }, apiKeyPrefix: { type: String, required: true },
  registeredOn: { type: Date, default: Date.now }, statusReason: { type: String, default: '' }
}, options);
export const BrokerMember = model('BrokerMember', memberSchema);

const depositorySchema = new Schema({
  depositoryId: { type: String, required: true, unique: true }, code: { type: String, required: true, unique: true, uppercase: true }, name: { type: String, required: true },
  mandiId: { type: String, required: true, index: true }, status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  contactEmail: { type: String, default: '' }, assetClasses: { type: [String], default: [] }
}, options);
export const Depository = model('Depository', depositorySchema);

const exchangeOrderSchema = new Schema({
  orderId: { type: String, required: true, unique: true }, brokerId: { type: String, required: true, index: true }, brokerOrderRef: { type: String, required: true },
  securityId: { type: String, default: '' }, symbol: { type: String, required: true, uppercase: true }, action: { type: String, enum: ['Buy', 'Sell'], required: true },
  quantity: { type: Number, required: true, min: 0 }, price: { type: Number, required: true, min: 0 }, filledQuantity: { type: Number, default: 0 },
  status: { type: String, enum: ['Draft', 'Open', 'Partially Executed', 'Executed', 'Cancelled', 'Rejected'], required: true }, rejectReason: { type: String, default: '' },
  statusReason: { type: String, default: '' }, mandiId: { type: String, required: true, index: true }, tenor: { type: String, enum: ['Spot', '1M'], default: 'Spot' },
  orderType: { type: String, enum: ['Limit'], default: 'Limit' }, timeInForce: { type: String, enum: ['GTC', 'DAY'], default: 'GTC' }, seq: { type: Number, required: true, index: true }, receivedAt: { type: Date, default: Date.now }
}, options);
exchangeOrderSchema.index({ brokerId: 1, brokerOrderRef: 1 }, { unique: true });
exchangeOrderSchema.index({ securityId: 1, tenor: 1, status: 1, price: 1, seq: 1 });
export const ExchangeOrder = model('ExchangeOrder', exchangeOrderSchema);

const executionSchema = new Schema({
  executionId: { type: String, required: true, unique: true }, seq: { type: Number, required: true, unique: true }, securityId: { type: String, required: true },
  symbol: { type: String, required: true }, mandiId: { type: String, required: true }, tenor: { type: String, required: true }, price: { type: Number, required: true }, quantity: { type: Number, required: true },
  buyOrderId: { type: String, required: true }, sellOrderId: { type: String, required: true }, buyBrokerId: { type: String, required: true }, sellBrokerId: { type: String, required: true },
  tradeDate: { type: String, required: true }, executedAt: { type: Date, default: Date.now }
}, options);
export const Execution = model('Execution', executionSchema);

const obligationSchema = new Schema({
  obligationId: { type: String, required: true, unique: true }, executionId: { type: String, required: true, index: true }, seq: { type: Number, required: true },
  brokerId: { type: String, required: true, index: true }, counterpartyBrokerId: { type: String, required: true }, side: { type: String, enum: ['Buy', 'Sell'], required: true },
  securityId: { type: String, required: true }, symbol: { type: String, required: true }, mandiId: { type: String, required: true }, tenor: { type: String, required: true },
  quantity: { type: Number, required: true }, price: { type: Number, required: true }, consideration: { type: Number, required: true }, currency: { type: String, required: true },
  tradeDate: { type: String, required: true }, settlementDate: { type: String, required: true }, settlementDays: { type: Number, required: true }, depositoryId: { type: String, required: true },
  lotIds: { type: [String], default: [] }, deliveredWeight: { type: Number, default: 0 }, cashLeg: { type: String, enum: ['Unsettled', 'Settled', 'Failed'], default: 'Unsettled' },
  securityLeg: { type: String, enum: ['Instructed', 'Attested', 'Failed'], default: 'Instructed' }, status: { type: String, enum: ['Unsettled', 'Settled', 'Failed'], default: 'Unsettled' },
  failedReason: { type: String, default: '' }, settledAt: Date
}, options);
obligationSchema.index({ executionId: 1, brokerId: 1, side: 1 }, { unique: true });
export const Obligation = model('Obligation', obligationSchema);

const instructionSchema = new Schema({
  instructionId: { type: String, required: true, unique: true }, obligationId: { type: String, required: true, unique: true }, executionId: { type: String, required: true },
  depositoryId: { type: String, required: true }, brokerId: { type: String, required: true }, symbol: { type: String, required: true }, mandiId: { type: String, required: true },
  delivery: { type: String, enum: ['Receive', 'Deliver'], required: true }, quantity: { type: Number, required: true }, consideration: { type: Number, required: true }, currency: { type: String, required: true },
  settlementDate: { type: String, required: true }, status: { type: String, enum: ['Issued', 'Attested', 'Failed'], default: 'Issued' }, issuedAt: { type: Date, default: Date.now }, attestedAt: Date,
  attestedBy: { type: String, default: '' }, note: { type: String, default: '' }
}, options);
export const SettlementInstruction = model('SettlementInstruction', instructionSchema);

const exchangeLotSchema = new Schema({
  lotId: { type: String, required: true, unique: true }, securityId: { type: String, required: true }, symbol: { type: String, required: true }, depositoryId: { type: String, required: true },
  ownerBrokerId: { type: String, required: true, index: true }, weight: { type: Number, required: true, min: 0.00000001 }, status: { type: String, enum: ['Held', 'Obligated', 'Delivered'], default: 'Held' },
  statusReason: { type: String, default: '' }, obligationId: { type: String, default: '' }
}, options);
export const ExchangeLot = model('ExchangeLot', exchangeLotSchema);
