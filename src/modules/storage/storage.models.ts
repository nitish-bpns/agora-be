import { Schema, model } from 'mongoose';
const options = { timestamps: true, versionKey: false } as const;

const vaultSchema = new Schema({ depositoryId: { type: String, required: true, unique: true }, name: { type: String, required: true }, status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' } }, options);
export const Vault = model('Vault', vaultSchema);

const lotSchema = new Schema({
  lotId: { type: String, required: true, unique: true }, depositoryId: { type: String, required: true, index: true }, securityId: { type: String, required: true, index: true },
  securitySymbol: { type: String, required: true }, ownerId: { type: String, required: true, index: true }, weight: { type: Number, required: true, min: 0.00000001 },
  properties: { type: Schema.Types.Mixed, default: {} }, status: { type: String, enum: ['Held', 'Withdrawn'], default: 'Held' }, statusReason: { type: String, default: '' }
}, options);
export const CustodyLot = model('CustodyLot', lotSchema);

const transferSchema = new Schema({
  transferId: { type: String, required: true, unique: true }, lotId: { type: String, required: true, index: true }, fromOwner: { type: String, required: true },
  toOwner: { type: String, required: true }, reason: { type: String, required: true }, actorId: { type: String, required: true }, at: { type: Date, default: Date.now }
}, { versionKey: false });
export const CustodyTransfer = model('CustodyTransfer', transferSchema);
