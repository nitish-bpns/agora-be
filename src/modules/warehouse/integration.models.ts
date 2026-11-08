import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/* ------------------------------------------------------------------ */
/* Device registry (Phase 1: planned/configured; no fake connectivity) */
/* ------------------------------------------------------------------ */

export const DEVICE_CATEGORIES = ['MoistureMeter', 'EnvironmentalSensor', 'Camera', 'VehicleTracker', 'Other'] as const;
export const DEVICE_STATUSES = ['Planned', 'ConfiguredNotConnected', 'Connected', 'TemporarilyOffline', 'Error', 'Disabled'] as const;
export const CONNECTION_METHODS = ['MQTT', 'HTTPS', 'ModbusRTU', 'ModbusTCP', 'Bluetooth', 'USB', 'Serial', 'ProviderAPI', 'Other'] as const;

const deviceSchema = new Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null, index: true },
  locationId: { type: String, default: null },
  category: { type: String, enum: DEVICE_CATEGORIES, required: true },
  manufacturer: { type: String, default: '' },
  model: { type: String, default: '' },
  catalogueModelId: { type: String, default: null },
  serialNumber: { type: String, default: '' },
  integrationType: { type: String, default: '' }, // adapter id
  connectionMethod: { type: String, enum: CONNECTION_METHODS, default: 'Other' },
  status: { type: String, enum: DEVICE_STATUSES, default: 'Planned' },
  enabled: { type: Boolean, default: true },
  config: { type: Schema.Types.Mixed, default: {} }, // adapter-specific config
  lastSuccessfulCommAt: { type: Date, default: null }, // only set by real integration
  lastError: { type: String, default: '' },
  calibrationRef: { type: String, default: '' },
  installationNotes: { type: String, default: '' },
  maintenanceNotes: { type: String, default: '' },
  supportedMeasurands: [{ type: String, default: '' }],
  createdBy: { type: String, default: '' }
}, options);
deviceSchema.index({ organizationId: 1, facilityId: 1, category: 1 });
deviceSchema.index({ serialNumber: 1 }, { unique: true, sparse: true });
export const Device = model('Device', deviceSchema);

/* ------------------------------------------------------------------ */
/* Hardware compatibility catalogue (configurable, no invented claims)  */
/* ------------------------------------------------------------------ */

export const VERIFICATION_STATUSES = ['VerifiedByTesting', 'ManufacturerDocumented', 'NotYetVerified', 'Unsupported'] as const;

const hardwareCatalogueSchema = new Schema({
  modelId: { type: String, required: true, unique: true, index: true },
  category: { type: String, enum: DEVICE_CATEGORIES, required: true },
  manufacturer: { type: String, required: true },
  model: { type: String, required: true },
  supportedMeasurands: [{ type: String }],
  communicationInterfaces: [{ type: String }],
  requiredAdapter: { type: String, default: '' },
  configurationOptions: { type: Schema.Types.Mixed, default: {} },
  integrationStatus: { type: String, default: 'NotIntegrated' },
  verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'NotYetVerified' },
  documentationRefs: [{ type: String }],
  knownLimitations: { type: String, default: '' }
}, options);
export const HardwareCatalogue = model('HardwareCatalogue', hardwareCatalogueSchema);

/* ------------------------------------------------------------------ */
/* Standardized measurement records (Phase 2 ingestion-ready schema)   */
/* ------------------------------------------------------------------ */

export const MEASUREMENT_TYPES = ['Temperature', 'RelativeHumidity', 'MoisturePct', 'DewPoint', 'Pressure', 'Other'] as const;
export const MEASUREMENT_QUALITY = ['Good', 'Caution', 'Stale', 'Invalid'] as const;

const measurementSchema = new Schema({
  measurementId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null, index: true },
  locationId: { type: String, default: null },
  lotId: { type: String, default: null },
  deviceId: { type: String, default: null, index: true },
  measurementType: { type: String, enum: MEASUREMENT_TYPES, required: true },
  value: { type: Number, required: true },
  unit: { type: String, required: true },
  measuredAt: { type: Date, required: true },
  ingestedAt: { type: Date, default: Date.now },
  dataSource: { type: String, enum: ['Device', 'Manual'], default: 'Manual' },
  operatorId: { type: String, default: null },     // user for manual entries
  quality: { type: String, enum: MEASUREMENT_QUALITY, default: 'Good' },
  calibrationRef: { type: String, default: '' },
  devicePayloadRef: { type: String, default: '' },
  originalPayload: { type: Schema.Types.Mixed, default: {} }
}, options);
measurementSchema.index({ deviceId: 1, measuredAt: -1 });
measurementSchema.index({ lotId: 1, measuredAt: -1 });
export const Measurement = model('Measurement', measurementSchema);

/* ------------------------------------------------------------------ */
/* Camera images & grading records (Phase 1: manual capture only)      */
/* ------------------------------------------------------------------ */

export const GRADE_STATUSES = ['PendingReview', 'Approved', 'Rejected', 'Overridden'] as const;

const imageSchema = new Schema({
  imageId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null },
  cameraId: { type: String, default: null },
  lotId: { type: String, default: null },
  sampleId: { type: String, default: null },
  url: { type: String, default: '' },
  capturedAt: { type: Date, default: Date.now },
  capturedBy: { type: String, default: '' },
  notes: { type: String, default: '' }
}, options);
export const ImageRecord = model('ImageRecord', imageSchema);

const gradingRecordSchema = new Schema({
  gradingId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, default: null },
  lotId: { type: String, default: null, index: true },
  sampleId: { type: String, default: null },
  imageId: { type: String, default: null },
  aiModelVersion: { type: String, default: null },  // only with a real AI model (Phase 2)
  predictedGrade: { type: String, default: null },
  confidence: { type: Number, default: null },
  humanGrade: { type: String, default: null },
  status: { type: String, enum: GRADE_STATUSES, default: 'PendingReview' },
  reviewedBy: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
  overrideReason: { type: String, default: '' },
  notes: { type: String, default: '' }
}, options);
export const GradingRecord = model('GradingRecord', gradingRecordSchema);
