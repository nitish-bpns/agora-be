import { Schema, model } from 'mongoose';

const counterSchema = new Schema({ name: { type: String, required: true, unique: true }, value: { type: Number, required: true, default: 0 } }, { versionKey: false });
export const Counter = model('Counter', counterSchema);

const settingSchema = new Schema({ scope: { type: String, required: true }, name: { type: String, required: true }, value: { type: Schema.Types.Mixed, required: true } }, { timestamps: true, versionKey: false });
settingSchema.index({ scope: 1, name: 1 }, { unique: true });
export const Setting = model('Setting', settingSchema);
