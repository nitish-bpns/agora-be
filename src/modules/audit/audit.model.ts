import { Schema, model } from 'mongoose';

const auditSchema = new Schema({
  auditId: { type: String, required: true, unique: true, index: true },
  realm: { type: String, enum: ['Desk', 'Broker', 'Exchange', 'Storage'], required: true, index: true },
  collection: { type: String, required: true, index: true },
  recordId: { type: String, required: true, index: true },
  action: { type: String, required: true },
  field: { type: String, required: true },
  oldValue: { type: Schema.Types.Mixed },
  newValue: { type: Schema.Types.Mixed },
  actorId: { type: String, default: 'system' },
  metadata: { type: Schema.Types.Mixed }
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, suppressReservedKeysWarning: true });

auditSchema.index({ realm: 1, createdAt: -1 });
export const AuditEvent = model('AuditEvent', auditSchema);
