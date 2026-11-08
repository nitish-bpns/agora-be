import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, parse } from '../../common/http.js';
import { coldAuth, coldFacilityRequired, coldRoleGuard } from './cold.middleware.js';
import { createBill, postBill, createPayment, generateFinancialStatements, customerOutstanding, listBills, reverseJournal, ensureDefaultAccounts, generateCashFlow, partyLedger, dayBook, gstSummary, consolidatedStatements } from './finance.service.js';
import { listAccounts, createAccount } from './master.service.js';

export const coldFinanceRouter = Router();
coldFinanceRouter.use(coldAuth);

coldFinanceRouter.use(asyncHandler(async (req, _res, next) => {
  if (req.cold && req.cold.organizationIds[0]) await ensureDefaultAccounts(req.cold.organizationIds[0]);
  next();
}));

/* Accounts (chart of accounts) */
coldFinanceRouter.get('/accounts', asyncHandler(async (req, res) => {
  const accounts = await listAccounts(req.cold!.organizationIds[0]!);
  res.json({ items: accounts });
}));
coldFinanceRouter.post('/accounts', coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ code: z.string().min(1), name: z.string().min(1), accountType: z.enum(['Asset', 'Liability', 'Equity', 'Income', 'Expense']), isDefault: z.boolean().optional(), parentAccountId: z.string().optional().nullable() }), req.body);
  res.status(201).json(await createAccount({ organizationId: req.cold!.organizationIds[0]!, ...body }, req.auth!.subject));
}));

/* Bills */
coldFinanceRouter.get('/bills', asyncHandler(async (req, res) => {
  const query = parse(z.object({ customerId: z.string().optional(), status: z.string().optional(), facilityId: z.string().optional(), page: z.string().optional(), limit: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await listBills({ organizationId: req.cold!.organizationIds[0]!, customerId: query.customerId, status: query.status, facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined, page: query.page ? Number(query.page) : undefined, limit: query.limit ? Number(query.limit) : undefined }));
}));
coldFinanceRouter.post('/bills', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    customerId: z.string().min(1), billDate: z.string().optional(), dueDate: z.string().optional().nullable(),
    periodFrom: z.string().optional().nullable(), periodTo: z.string().optional().nullable(),
    lines: z.array(z.object({ chargeTypeId: z.string().min(1), quantity: z.number().optional(), unitId: z.string().optional().nullable(), description: z.string().optional(), lotId: z.string().optional().nullable() })).min(1),
    discount: z.number().nonnegative().optional(), note: z.string().optional()
  }), req.body);
  res.status(201).json(await createBill({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));
coldFinanceRouter.post('/bills/:billId/post', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  res.json(await postBill({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, billId: String(req.params.billId ?? '') }, req.auth!.subject, req.cold!.role));
}));

/* Receipts & payments */
coldFinanceRouter.post('/payments', coldFacilityRequired, coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  const body = parse(z.object({
    paymentType: z.enum(['Receipt', 'Payment']), partyId: z.string().min(1), paymentDate: z.string().optional(),
    method: z.enum(['Cash', 'BankTransfer', 'Cheque', 'UPI', 'Card', 'Other']), referenceNumber: z.string().optional(),
    amount: z.number().positive(), allocatedTo: z.array(z.object({ billId: z.string().min(1), amount: z.number().positive() })).min(1),
    clientOpId: z.string().optional().nullable()
  }), req.body);
  res.status(201).json(await createPayment({ organizationId: req.cold!.organizationIds[0]!, facilityId: req.cold!.facilityId!, ...body }, req.auth!.subject, req.cold!.role));
}));

/* Financial statements & reports */
coldFinanceRouter.get('/statements', asyncHandler(async (req, res) => {
  const query = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await generateFinancialStatements({ organizationId: req.cold!.organizationIds[0]!, from: query.from, to: query.to }));
}));
coldFinanceRouter.get('/outstanding', asyncHandler(async (req, res) => {
  res.json({ items: await customerOutstanding(req.cold!.organizationIds[0]!, req.cold!.facilityId ?? undefined) });
}));
coldFinanceRouter.post('/journals/:journalId/reverse', coldRoleGuard('OrgAdmin', 'FacilityManager', 'AccountsOperator'), asyncHandler(async (req, res) => {
  res.json(await reverseJournal({ organizationId: req.cold!.organizationIds[0]!, journalId: String(req.params.journalId ?? '') }, req.auth!.subject, req.cold!.role));
}));

/* Phase 3 finance depth */
coldFinanceRouter.get('/cashflow', asyncHandler(async (req, res) => {
  const query = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await generateCashFlow({ organizationId: req.cold!.organizationIds[0]!, from: query.from, to: query.to }));
}));
coldFinanceRouter.get('/ledger', asyncHandler(async (req, res) => {
  const query = parse(z.object({ partyId: z.string().min(1), from: z.string().optional(), to: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await partyLedger({ organizationId: req.cold!.organizationIds[0]!, partyId: query.partyId, from: query.from, to: query.to }));
}));
coldFinanceRouter.get('/daybook', asyncHandler(async (req, res) => {
  const query = parse(z.object({ from: z.string().optional(), to: z.string().optional(), facilityId: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await dayBook({ organizationId: req.cold!.organizationIds[0]!, from: query.from, to: query.to, facilityId: query.facilityId ?? req.cold!.facilityId ?? undefined }));
}));
coldFinanceRouter.get('/gst', asyncHandler(async (req, res) => {
  const query = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query as Record<string, unknown>);
  res.json(await gstSummary({ organizationId: req.cold!.organizationIds[0]!, from: query.from, to: query.to }));
}));
coldFinanceRouter.get('/consolidated', asyncHandler(async (req, res) => {
  res.json(await consolidatedStatements());
}));
