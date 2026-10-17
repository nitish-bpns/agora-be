import { Schema, model } from 'mongoose';

const operatorSchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  username: { type: String, required: true, trim: true, lowercase: true },
  displayName: { type: String, required: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  realm: { type: String, enum: ['Desk', 'Broker', 'Exchange', 'Storage'], required: true },
  role: { type: String, enum: ['Admin', 'Operations', 'Read-only'], required: true, default: 'Read-only' },
  isActive: { type: Boolean, default: true },
  passwordChanged: { type: Boolean, default: false }
}, { timestamps: true, versionKey: false });
operatorSchema.index({ realm: 1, username: 1 }, { unique: true });
operatorSchema.index({ username: 1 }, { unique: true });
export const Operator = model('Operator', operatorSchema);
