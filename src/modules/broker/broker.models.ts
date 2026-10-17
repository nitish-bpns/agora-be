import { Schema, model } from 'mongoose';
const options = { timestamps: true, versionKey: false } as const;

const profileSchema = new Schema({
  profileId: { type: String, default: 'default', unique: true }, exchangeBrokerId: { type: String, required: true }, mandiId: { type: String, required: true },
  principalStepIn: { type: Boolean, default: false }, executionCursor: { type: Number, default: 0 }, obligationCursor: { type: Number, default: 0 }
}, options);
export const BrokerProfile = model('BrokerProfile', profileSchema);

const replicaSchema = new Schema({
  securityId: { type: String, required: true, unique: true }, symbol: { type: String, required: true, unique: true }, isin: { type: String, default: '' }, name: { type: String, required: true },
  assetType: { type: String, required: true }, sector: { type: String, default: '' }, currency: { type: String, required: true }, mandiId: { type: String, required: true },
  tickSize: Number, lotSize: Number, priceBandPct: Number, referencePrice: Number, settlementDays: Number, depositoryId: String, listingStatus: String, replicatedAt: { type: Date, default: Date.now }
}, options);
export const SecurityReplica = model('SecurityReplica', replicaSchema);

const brokerOrderSchema = new Schema({
  orderId: { type: String, required: true, unique: true }, traderId: { type: String, required: true, index: true }, accountId: { type: String, required: true, index: true },
  symbol: { type: String, required: true }, action: { type: String, enum: ['Buy', 'Sell'], required: true }, quantity: { type: Number, required: true }, price: { type: Number, required: true },
  clientRef: { type: String }, routingStatus: { type: String, enum: ['Pending', 'Routed', 'Rejected', 'Refused', 'Unrouted'], default: 'Pending' }, exchangeOrderId: { type: String, sparse: true, unique: true },
  exchangeStatus: { type: String, default: '' }, rejectReason: { type: String, default: '' }, routeReason: { type: String, default: '' }, routeAttempts: { type: Number, default: 0 },
  tenor: { type: String, enum: ['Spot', '1M'], default: 'Spot' }, principalAttempted: { type: Boolean, default: false }, routedAt: Date, seq: { type: Number, required: true }, receivedAt: { type: Date, default: Date.now }
}, options);
brokerOrderSchema.index({ traderId: 1, clientRef: 1 }, { unique: true, sparse: true });
export const BrokerOrder = model('BrokerOrder', brokerOrderSchema);

const brokerExecutionSchema = new Schema({
  ownExecutionId: { type: String, required: true, unique: true }, executionId: { type: String, required: true }, seq: { type: Number, required: true }, symbol: String, tenor: String,
  price: Number, quantity: Number, side: { type: String, enum: ['Buy', 'Sell'] }, ownOrderId: String, counterpartyOrderId: String, counterpartyBrokerId: String,
  tradeDate: String, executedAt: Date, orderId: String, traderId: { type: String, index: true }, accountId: { type: String, index: true }, attributed: { type: Boolean, default: false }, ingestedAt: { type: Date, default: Date.now }
}, options);
export const BrokerExecution = model('BrokerExecution', brokerExecutionSchema);

const brokerObligationSchema = new Schema({
  obligationId: { type: String, required: true, unique: true }, executionId: String, ownExecutionId: String, seq: Number, side: { type: String, enum: ['Buy', 'Sell'] }, symbol: String,
  quantity: Number, price: Number, consideration: Number, currency: String, tradeDate: String, settlementDate: String, settlementDays: Number, depositoryId: String,
  cashLeg: String, securityLeg: String, status: String, failedReason: String, settledAt: Date, counterpartyBrokerId: String, ownOrderId: String,
  orderId: String, traderId: { type: String, index: true }, accountId: { type: String, index: true }, attributed: { type: Boolean, default: false }, ingestedAt: { type: Date, default: Date.now }
}, options);
export const BrokerObligation = model('BrokerObligation', brokerObligationSchema);

const enlistmentSchema = new Schema({
  enlistmentId: { type: String, required: true, unique: true }, accountId: { type: String, required: true, index: true }, traderId: { type: String, required: true }, symbol: { type: String, required: true },
  securityId: { type: String, required: true }, depositoryId: { type: String, required: true }, lots: { type: [{ lotId: String, weight: Number }], required: true },
  status: { type: String, enum: ['Declared', 'Enlisted'], default: 'Declared' }, enlistedAt: Date, note: { type: String, default: '' }
}, options);
export const Enlistment = model('Enlistment', enlistmentSchema);
