import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/**
 * Public website lead — a prospect contacting the Agora team from the
 * marketing site (no authentication). Used for sales/enquiry triage.
 */
const leadSchema = new Schema({
  leadId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true, index: true },
  phone: { type: String, default: '', trim: true },
  company: { type: String, default: '', trim: true },
  interest: { type: String, default: 'General enquiry' },
  message: { type: String, required: true, trim: true },
  source: { type: String, default: 'website' },
  status: { type: String, enum: ['New', 'Contacted', 'Qualified', 'Closed'], default: 'New', index: true },
  ipAddress: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}, options);
leadSchema.index({ status: 1, createdAt: -1 });
export const Lead = model('Lead', leadSchema);