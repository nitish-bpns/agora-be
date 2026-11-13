import { Counter } from './models.js';

const prefixes = {
  user: 'USR', trader: 'TRD', account: 'ACC', mandi: 'MND', instrument: 'INS', security: 'SEC',
  broker: 'BKR', depository: 'DEP', order: 'ORD', execution: 'EXE', obligation: 'OBL', instruction: 'STI',
  lot: 'LOT', transfer: 'TRF', trade: 'TRD', ticket: 'TKT', cash: 'CSH', enlistment: 'ENL', audit: 'AUD',
  organization: 'ORG', facility: 'FAC', party: 'PRT', commodity: 'CMD', variety: 'VAR', unit: 'UNT',
  packaging: 'PKG', location: 'LOC', pallet: 'PAL', department: 'DPT', employee: 'EMP', vehicle: 'VEH',
  driver: 'DRV', facilityUser: 'FCU', chargeType: 'CHG', movement: 'MOV', genealogy: 'GEN',
  ownershipEvent: 'OWN', gatepass: 'GTP', interFacilityTransfer: 'IFT', trip: 'TRP', period: 'PRD',
  journal: 'JRN', bill: 'BIL', payment: 'PAY', device: 'DEV', catalogueModel: 'CAT', measurement: 'MEA',
  image: 'IMG', grading: 'GRD', financer: 'FIN', pledgeApplication: 'PLA', pledge: 'PLG', pledgeTransaction: 'PLT', lead: 'LEAD'
} as const;

export type IdKind = keyof typeof prefixes;

export async function nextId(kind: IdKind): Promise<string> {
  const counter = await Counter.findOneAndUpdate({ name: kind }, { $inc: { value: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return `${prefixes[kind]}-${String(counter.value).padStart(8, '0')}`;
}
