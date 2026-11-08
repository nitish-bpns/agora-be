import { Schema, model } from 'mongoose';

const options = { timestamps: true, versionKey: false } as const;

/* ------------------------------------------------------------------ */
/* Lots                                                                */
/* ------------------------------------------------------------------ */

export const LOT_STATUSES = ['Active', 'Held', 'PartiallyWithdrawn', 'Withdrawn', 'Merged', 'Transferred', 'Adjusted', 'Closed'] as const;
/** Pledge lien state of a lot. FullyPledged lots are locked from outward/trading. */
export const LOT_PLEDGE_STATUSES = ['Unpledged', 'PartiallyPledged', 'FullyPledged'] as const;

const lotSchema = new Schema({
  lotId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  lotNumber: { type: String, required: true, unique: true, index: true }, // stable QR-encodable id
  commodityId: { type: String, required: true, index: true },
  varietyId: { type: String, default: null },
  packagingId: { type: String, default: null },
  quantityUnitId: { type: String, required: true },
  ownerId: { type: String, required: true, index: true },       // party owning the goods
  custodianFacilityId: { type: String, required: true, index: true }, // facility physically holding
  locationId: { type: String, required: true, index: true },
  palletId: { type: String, default: null, index: true },
  openingQuantity: { type: Number, required: true, min: 0 },
  currentQuantity: { type: Number, required: true, min: 0 },
  // Quantity pledged as security for loans (lien). Held by the financer; cannot be
  // withdrawn/transferred/traded until the pledge is repaid or the stock is released.
  pledgedQuantity: { type: Number, default: 0, min: 0 },
  pledgeStatus: { type: String, enum: LOT_PLEDGE_STATUSES, default: 'Unpledged', index: true },
  packageCount: { type: Number, default: 0 },
  avgMoisturePct: { type: Number, default: null },
  status: { type: String, enum: LOT_STATUSES, default: 'Active', index: true },
  statusReason: { type: String, default: '' },
  isOperatorOwned: { type: Boolean, default: false },
  notes: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  closedAt: { type: Date, default: null }
}, options);
lotSchema.index({ organizationId: 1, facilityId: 1, status: 1 });
lotSchema.index({ ownerId: 1, status: 1 });
lotSchema.index({ pledgeStatus: 1, status: 1 });
export const Lot = model('Lot', lotSchema);

/* ------------------------------------------------------------------ */
/* Movement ledger (append-only; balances derive from these)          */
/* ------------------------------------------------------------------ */

export const MOVEMENT_TYPES = ['Inward', 'Outward', 'Relocate', 'Adjust', 'SplitFrom', 'SplitInto', 'MergedFrom', 'TransferDispatch', 'TransferReceive', 'Revalue'] as const;

const movementSchema = new Schema({
  movementId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  lotId: { type: String, required: true, index: true },
  type: { type: String, enum: MOVEMENT_TYPES, required: true },
  direction: { type: String, enum: ['In', 'Out'], required: true },
  quantity: { type: Number, required: true },
  weightKg: { type: Number, default: 0 },
  packageCount: { type: Number, default: 0 },
  unitId: { type: String, required: true },
  fromLocationId: { type: String, default: null },
  toLocationId: { type: String, default: null },
  fromOwnerId: { type: String, default: null },
  toOwnerId: { type: String, default: null },
  reason: { type: String, default: '' },
  reasonCode: { type: String, default: '' },
  authorizedById: { type: String, default: null },
  actorId: { type: String, required: true },
  referenceType: { type: String, default: '' },   // gatepass, transfer, bill...
  referenceId: { type: String, default: null },
  clientOpId: { type: String, default: null }, // offline idempotency key (indexed below)
  createdAt: { type: Date, default: Date.now }
}, options);
movementSchema.index({ lotId: 1, createdAt: 1 });
movementSchema.index({ facilityId: 1, type: 1, createdAt: 1 });
movementSchema.index({ clientOpId: 1 }, { unique: true, partialFilterExpression: { clientOpId: { $type: 'string' } } });
export const Movement = model('Movement', movementSchema);

/* ------------------------------------------------------------------ */
/* Genealogy events (splits/merges/transfers/adjustments)              */
/* ------------------------------------------------------------------ */

export const GENEALOGY_TYPES = ['Inward', 'Outward', 'Split', 'Merge', 'Transfer', 'Adjust'] as const;

const genealogyEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  type: { type: String, enum: GENEALOGY_TYPES, required: true },
  sourceLotIds: [{ type: String, required: true }],
  targetLotIds: [{ type: String, required: true }],
  quantitiesBefore: { type: Schema.Types.Mixed, default: {} }, // lotId -> qty
  quantitiesAfter: { type: Schema.Types.Mixed, default: {} },
  unitId: { type: String, required: true },
  reason: { type: String, required: true },
  actorId: { type: String, required: true },
  referenceType: { type: String, default: '' },
  referenceId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
}, options);
genealogyEventSchema.index({ sourceLotIds: 1 });
genealogyEventSchema.index({ targetLotIds: 1 });
export const GenealogyEvent = model('GenealogyEvent', genealogyEventSchema);

/* ------------------------------------------------------------------ */
/* Ownership & custody ledger                                         */
/* ------------------------------------------------------------------ */

export const OWNERSHIP_TYPES = ['Create', 'Transfer', 'Split', 'Merge', 'Adjust'] as const;

const ownershipEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  lotId: { type: String, required: true, index: true },
  type: { type: String, enum: OWNERSHIP_TYPES, required: true },
  fromOwnerId: { type: String, default: null },
  toOwnerId: { type: String, required: true },
  quantity: { type: Number, default: 0 },
  facilityId: { type: String, default: null },
  reason: { type: String, default: '' },
  actorId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, options);
export const OwnershipEvent = model('OwnershipEvent', ownershipEventSchema);

/* ------------------------------------------------------------------ */
/* Gatepasses                                                          */
/* ------------------------------------------------------------------ */

export const GATEPASS_TYPES = ['Inward', 'Outward', 'TransferDispatch', 'TransferReceive', 'Return'] as const;
export const GATEPASS_STATUSES = ['Draft', 'Approved', 'Open', 'Completed', 'Cancelled'] as const;

const gatepassSchema = new Schema({
  gatepassId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  gatepassNumber: { type: String, required: true },
  type: { type: String, enum: GATEPASS_TYPES, required: true },
  status: { type: String, enum: GATEPASS_STATUSES, default: 'Draft' },
  partyId: { type: String, default: null },
  vehicleId: { type: String, default: null },
  driverId: { type: String, default: null },
  transportReference: { type: String, default: '' },
  items: [{
    lotId: { type: String, default: null },
    commodityId: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitId: { type: String, required: true },
    packageCount: { type: Number, default: 0 }
  }],
  openedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  actorId: { type: String, required: true },
  clientOpId: { type: String, default: null }, // offline idempotency key (indexed below)
  createdAt: { type: Date, default: Date.now }
}, options);
gatepassSchema.index({ facilityId: 1, status: 1 });
gatepassSchema.index({ clientOpId: 1 }, { unique: true, partialFilterExpression: { clientOpId: { $type: 'string' } } });
export const Gatepass = model('Gatepass', gatepassSchema);

/* ------------------------------------------------------------------ */
/* Inter-facility transfers                                            */
/* ------------------------------------------------------------------ */

export const TRANSFER_STATUSES = ['Draft', 'Dispatched', 'InTransit', 'Delivered', 'ReceivedWithDiscrepancy', 'Cancelled'] as const;

const transferSchema = new Schema({
  transferId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  transferNumber: { type: String, required: true },
  fromFacilityId: { type: String, required: true, index: true },
  toFacilityId: { type: String, required: true, index: true },
  status: { type: String, enum: TRANSFER_STATUSES, default: 'Draft' },
  items: [{
    lotId: { type: String, required: true },
    commodityId: { type: String, required: true },
    quantity: { type: Number, required: true },
    unitId: { type: String, required: true },
    packageCount: { type: Number, default: 0 }
  }],
  vehicleId: { type: String, default: null },
  driverId: { type: String, default: null },
  gatepassId: { type: String, default: null },
  dispatchedAt: { type: Date, default: null },
  receivedAt: { type: Date, default: null },
  discrepancies: [{
    lotId: { type: String, required: true },
    expectedQty: { type: Number, required: true },
    receivedQty: { type: Number, required: true },
    damageQty: { type: Number, default: 0 },
    unitId: { type: String, required: true },
    note: { type: String, default: '' }
  }],
  actorId: { type: String, required: true },
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
}, options);
export const InterFacilityTransfer = model('InterFacilityTransfer', transferSchema);

/* ------------------------------------------------------------------ */
/* Trips (vehicle tracking optional; works with no tracker)             */
/* ------------------------------------------------------------------ */

export const TRIP_STATUSES = ['Planned', 'Departed', 'Arrived', 'Completed', 'Cancelled'] as const;

const tripSchema = new Schema({
  tripId: { type: String, required: true, unique: true, index: true },
  organizationId: { type: String, required: true, index: true },
  facilityId: { type: String, required: true, index: true },
  tripNumber: { type: String, required: true },
  transferId: { type: String, default: null, index: true },
  vehicleId: { type: String, required: true },
  driverId: { type: String, default: null },
  status: { type: String, enum: TRIP_STATUSES, default: 'Planned' },
  // Manual status updates only in Phase 1; live GPS arrives in Phase 2.
  departureAt: { type: Date, default: null },
  arrivalAt: { type: Date, default: null },
  departureNote: { type: String, default: '' },
  arrivalNote: { type: String, default: '' },
  trackingAvailable: { type: Boolean, default: false }, // derived from vehicle.trackerStatus
  actorId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, options);
export const Trip = model('Trip', tripSchema);
