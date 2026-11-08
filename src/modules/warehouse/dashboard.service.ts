import { Commodity, StorageLocation } from './master.models.js';
import { Lot, Movement, Gatepass, InterFacilityTransfer } from './inventory.models.js';
import { Bill, JournalEntry } from './finance.models.js';

export interface DashboardData {
  todayInward: { movements: number; quantity: number };
  todayOutward: { movements: number; quantity: number };
  currentStock: { lots: number; quantity: number; weightKg: number };
  capacity: { locations: number; totalKg: number; usedKg: number; availableKg: number; utilizationPct: number };
  commodityBreakdown: Array<{ commodityId: string; name?: string; quantity: number; lots: number }>;
  income: { total: number; periodFrom?: string; periodTo?: string };
  expense: { total: number };
  receipts: { count: number; amount: number };
  outstanding: { count: number; amount: number }; // open bills (AR debtors)
  pendingGatepasses: { count: number };
  pendingTransfers: { count: number };
  pendingBills: { count: number };
  recentMovements: Array<{ movementId: string; type: string; quantity: number; lotId: string; createdAt: Date | string }>;
  emptyStates: { environmental: boolean; grading: boolean; devices: boolean };
}

export async function buildDashboard(input: { organizationId: string; facilityId?: string | null; since?: string }): Promise<DashboardData> {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  if (input.facilityId) filter.facilityId = input.facilityId;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sinceDate = input.since ? new Date(input.since) : today;

  const [inward, outward] = await Promise.all([
    Movement.find({ ...filter, type: 'Inward', createdAt: { $gte: sinceDate } }).lean(),
    Movement.find({ ...filter, type: 'Outward', createdAt: { $gte: sinceDate } }).lean()
  ]);
  const lots = await Lot.find({ ...filter, status: { $in: ['Active', 'PartiallyWithdrawn'] } }).lean();
  const locations = await StorageLocation.find({ ...filter, status: 'Active' }).lean();

  let totalKg = 0;
  let usedKg = 0;
  for (const location of locations) totalKg += location.capacityKg ?? 0;
  for (const lot of lots) usedKg += lot.currentQuantity;

  const commodityAgg = await Lot.aggregate([
    { $match: { organizationId: input.organizationId, ...(input.facilityId ? { facilityId: input.facilityId } : {}), status: { $in: ['Active', 'PartiallyWithdrawn'] } } },
    { $group: { _id: '$commodityId', quantity: { $sum: '$currentQuantity' }, lots: { $sum: 1 } } },
    { $sort: { quantity: -1 } },
    { $limit: 10 }
  ]);
  const commodities = await Commodity.find({ organizationId: input.organizationId }).lean();
  const commodityMap = new Map(commodities.map((c) => [c.commodityId, c.name]));

  const billFilter: Record<string, unknown> = { organizationId: input.organizationId, status: { $in: ['Posted', 'PartiallyPaid'] } };
  if (input.facilityId) billFilter.facilityId = input.facilityId;
  const [bills, journals, gatepasses, transfers] = await Promise.all([
    Bill.find(billFilter).lean(),
    JournalEntry.find({ ...filter, status: 'Posted' }).lean(),
    Gatepass.countDocuments({ ...filter, status: { $in: ['Draft', 'Approved', 'Open'] } }),
    InterFacilityTransfer.countDocuments({ ...filter, status: { $in: ['Draft', 'Dispatched', 'InTransit'] } })
  ]);

  const outstanding = bills.reduce((sum, bill) => sum + (bill.total - bill.paidAmount), 0);
  const pendingBills = bills.filter((bill) => bill.status === 'Posted' && bill.paidAmount <= 0).length;

  // Income = sum of credits posted to Income-type accounts
  const incomeAccounts = await JournalEntry.aggregate([
    { $match: { ...filter, status: 'Posted' } },
    { $unwind: '$lines' },
    { $match: { 'lines.credit': { $gt: 0 } } },
    { $group: { _id: '$lines.accountId', total: { $sum: '$lines.credit' } } }
  ]);
  const accounts = await Commodity.db.collection('accounts').find({ organizationId: input.organizationId, accountType: 'Income' }, { projection: { accountId: 1 } }).toArray();
  const incomeAccountIds = new Set(accounts.map((a) => String((a as { accountId?: unknown }).accountId ?? '')));
  const incomeRows = incomeAccounts as Array<{ _id: unknown; total: unknown }>;
  const income = incomeRows.filter((row) => incomeAccountIds.has(String(row._id ?? ''))).reduce((sum, row) => sum + Number(row.total ?? 0), 0);

  const recentMovements = await Movement.find(filter).sort({ createdAt: -1 }).limit(8).lean();

  return {
    todayInward: { movements: inward.length, quantity: inward.reduce((sum, m) => sum + m.quantity, 0) },
    todayOutward: { movements: outward.length, quantity: outward.reduce((sum, m) => sum + m.quantity, 0) },
    currentStock: { lots: lots.length, quantity: lots.reduce((sum, lot) => sum + lot.currentQuantity, 0), weightKg: usedKg },
    capacity: {
      locations: locations.length, totalKg, usedKg,
      availableKg: Math.max(0, totalKg - usedKg),
      utilizationPct: totalKg > 0 ? Math.round((usedKg / totalKg) * 100) / 100 : 0
    },
    commodityBreakdown: commodityAgg.map((row) => ({ commodityId: row._id, name: commodityMap.get(row._id as string) ?? row._id, quantity: row.quantity, lots: row.lots })),
    income: { total: Math.round(income * 100) / 100 },
    expense: { total: 0 },
    receipts: { count: journals.filter((j) => j.source === 'Receipt').length, amount: Math.round(journals.filter((j) => j.source === 'Receipt').reduce((sum, j) => sum + j.lines.filter((l) => l.debit > 0).reduce((s, l) => s + l.debit, 0), 0) * 100) / 100 },
    outstanding: { count: outstanding > 0 ? bills.length : 0, amount: Math.round(outstanding * 100) / 100 },
    pendingGatepasses: { count: gatepasses },
    pendingTransfers: { count: transfers },
    pendingBills: { count: pendingBills },
    recentMovements,
    emptyStates: { environmental: true, grading: true, devices: true }
  };
}
