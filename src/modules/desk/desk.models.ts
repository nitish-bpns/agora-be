import { Schema, model } from 'mongoose';
const options = { timestamps: true, versionKey: false } as const;

const accountSchema = new Schema({ accountId: { type: String, required: true, unique: true }, label: { type: String, required: true }, traderId: { type: String, default: '' }, brokerConnectionId: { type: String, default: 'BRC-LOCAL' }, active: { type: Boolean, default: true } }, options);
export const DeskAccount = model('DeskAccount', accountSchema);

const connectionSchema = new Schema({ connectionId: { type: String, required: true, unique: true }, label: { type: String, required: true }, brokerProfileId: { type: String, default: 'default' }, mandiId: { type: String, default: '' }, mandiCode: { type: String, default: '' }, brokerCode: { type: String, default: '' }, isDefault: { type: Boolean, default: false }, lastSeenAt: Date }, options);
export const BrokerConnection = model('BrokerConnection', connectionSchema);

const instrumentSchema = new Schema({ instrumentId: { type: String, required: true, unique: true }, symbol: { type: String, required: true, unique: true }, name: { type: String, default: '' }, assetType: { type: String, default: 'Equity' }, currency: { type: String, default: 'USD' }, active: { type: Boolean, default: true }, mandiId: { type: String, default: '' } }, options);
export const DeskInstrument = model('DeskInstrument', instrumentSchema);

const ticketSchema = new Schema({ ticketId: { type: String, required: true, unique: true }, tradeOrigin: { type: String, enum: ['External', 'System'], default: 'External' }, description: { type: String, default: '' }, accountId: { type: String, required: true, index: true } }, options);
export const DeskTicket = model('DeskTicket', ticketSchema);

const orderSchema = new Schema({
  orderId: { type: String, required: true, unique: true }, instrumentId: { type: String, required: true }, action: { type: String, enum: ['Buy', 'Sell'], required: true }, quantity: { type: Number, required: true }, price: { type: Number, required: true },
  status: { type: String, enum: ['Draft', 'Open', 'Partially Executed', 'Executed', 'Cancelled', 'Rejected'], default: 'Draft' }, tradeDate: { type: String, required: true }, remarks: { type: String, default: '' },
  accountId: { type: String, required: true, index: true }, brokerOrderId: { type: String, default: '' }, brokerRoutingStatus: { type: String, default: '' }, brokerConnectionId: { type: String, default: 'BRC-LOCAL' }
}, options);
export const DeskOrder = model('DeskOrder', orderSchema);

const tradeSchema = new Schema({
  tradeId: { type: String, required: true, unique: true }, ticketId: { type: String, default: '' }, orderId: { type: String, default: '', index: true }, instrumentId: { type: String, required: true, index: true },
  action: { type: String, enum: ['Buy', 'Sell'], required: true }, quantity: { type: Number, required: true }, price: { type: Number, required: true }, charges: { type: Number, default: 0 }, currency: { type: String, default: 'USD' },
  tradeDate: { type: String, required: true }, settlementDate: { type: String, default: '' }, status: { type: String, enum: ['Draft', 'Submitted', 'Completed', 'Cancelled', 'Reversed'], default: 'Completed' },
  tradeOrigin: { type: String, enum: ['External', 'System'], default: 'External' }, reversedAt: Date, remarks: { type: String, default: '' }, accountId: { type: String, required: true, index: true }, executionId: { type: String, sparse: true, unique: true }
}, options);
tradeSchema.index({ accountId: 1, instrumentId: 1, tradeDate: 1, createdAt: 1 });
export const DeskTrade = model('DeskTrade', tradeSchema);

const priceSchema = new Schema({ instrumentId: { type: String, required: true }, price: { type: Number, required: true, min: 0.00000001 }, effectiveDate: { type: String, required: true } }, options);
priceSchema.index({ instrumentId: 1, effectiveDate: 1 }, { unique: true });
export const DeskPrice = model('DeskPrice', priceSchema);

const cashSchema = new Schema({ cashId: { type: String, required: true, unique: true }, tradeId: { type: String, default: '', index: true }, entryDate: { type: String, required: true }, currency: { type: String, default: 'USD' }, amount: { type: Number, required: true }, entryType: { type: String, enum: ['debit', 'credit', 'reversal', 'deposit', 'withdrawal', 'adjustment'], required: true }, description: { type: String, required: true }, accountId: { type: String, required: true, index: true } }, options);
export const CashEntry = model('CashEntry', cashSchema);

const deskObligationSchema = new Schema({
  obligationId: { type: String, required: true, unique: true }, executionId: String, exchangeExecutionId: String, tradeId: String, orderId: String, seq: Number, instrumentId: String, action: String,
  quantity: Number, price: Number, consideration: Number, currency: String, tradeDate: String, settlementDate: String, settlementDays: Number, depositoryId: String,
  cashLeg: String, securityLeg: String, status: String, failedReason: String, settledAt: Date, accountId: { type: String, required: true, index: true }, ingestedAt: { type: Date, default: Date.now }
}, options);
export const DeskObligation = model('DeskObligation', deskObligationSchema);
