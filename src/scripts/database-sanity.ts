import mongoose, { type Model } from 'mongoose';
import { env } from '../config/env.js';
import { User, UserSession } from '../modules/auth/auth.model.js';
import { BrokerExecution, BrokerObligation, BrokerOrder, Enlistment } from '../modules/broker/broker.models.js';
import { DeskAccount } from '../modules/desk/desk.models.js';
import { BrokerMember, Depository, ExchangeOrder, Execution, Instrument, Mandi, Obligation, Security } from '../modules/exchange/exchange.models.js';
import { CustodyLot, CustodyTransfer } from '../modules/storage/storage.models.js';

const errors: string[] = [];
const warnings: string[] = [];

type GenericModel = Model<Record<string, unknown>>;

async function assertReferences(source: GenericModel, field: string, target: GenericModel, targetField: string, label: string, ignoreEmpty = true): Promise<void> {
  const values = (await source.distinct(field) as unknown[]).filter((value) => !ignoreEmpty || value !== '' && value !== null && value !== undefined);
  if (!values.length) return;
  const existing = new Set((await target.distinct(targetField, { [targetField]: { $in: values } }) as unknown[]).map(String));
  const missing = values.map(String).filter((value) => !existing.has(value));
  if (missing.length) errors.push(`${label}: ${missing.length} missing reference(s): ${missing.slice(0, 5).join(', ')}`);
}

await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
try {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB is not connected');
  await database.command({ ping: 1 });
  const collections = (await database.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name).sort();
  const forbidden = ['operators', 'traders', 'tradersessions'].filter((name) => collections.includes(name));
  if (forbidden.length) errors.push(`Legacy identity collections exist: ${forbidden.join(', ')}`);

  const users = await User.find().select('+passwordHash').lean();
  const usernames = new Set<string>();
  const userIds = new Set<string>();
  const accountIds = new Set<string>();
  for (const user of users) {
    if (usernames.has(user.username)) errors.push(`Duplicate username: ${user.username}`); else usernames.add(user.username);
    if (userIds.has(user.userId)) errors.push(`Duplicate userId: ${user.userId}`); else userIds.add(user.userId);
    if (!user.passwordHash) errors.push(`Missing password hash: ${user.username}`);
    if (user.userType === 'Trader') {
      if (user.role !== 'Trader' || !user.accountId) errors.push(`Invalid Trader profile: ${user.username}`);
      else if (accountIds.has(user.accountId)) errors.push(`Duplicate accountId: ${user.accountId}`); else accountIds.add(user.accountId);
    } else if (user.role === 'Trader' || user.accountId) errors.push(`Invalid operator profile: ${user.username}`);
  }
  for (const userType of ['Trader', 'Broker', 'Exchange', 'Storage']) if (!users.some((user) => user.userType === userType && user.status === 'Active')) errors.push(`No active ${userType} user`);

  const userIndexes = await User.collection.indexes();
  const usernameIndex = userIndexes.find((index) => index.key.username === 1);
  if (!usernameIndex?.unique) errors.push('users.username unique index is missing');
  const sessionIndexes = await UserSession.collection.indexes();
  const expiryIndex = sessionIndexes.find((index) => index.key.expiresAt === 1);
  if (expiryIndex?.expireAfterSeconds !== 0) errors.push('usersessions.expiresAt TTL index is missing');

  await assertReferences(BrokerOrder as unknown as GenericModel, 'traderId', User as unknown as GenericModel, 'userId', 'brokerorders.traderId');
  await assertReferences(BrokerExecution as unknown as GenericModel, 'traderId', User as unknown as GenericModel, 'userId', 'brokerexecutions.traderId');
  await assertReferences(BrokerObligation as unknown as GenericModel, 'traderId', User as unknown as GenericModel, 'userId', 'brokerobligations.traderId');
  await assertReferences(Enlistment as unknown as GenericModel, 'traderId', User as unknown as GenericModel, 'userId', 'enlistments.traderId');
  await assertReferences(DeskAccount as unknown as GenericModel, 'traderId', User as unknown as GenericModel, 'userId', 'deskaccounts.traderId');
  await assertReferences(Security as unknown as GenericModel, 'instrumentId', Instrument as unknown as GenericModel, 'instrumentId', 'securities.instrumentId');
  await assertReferences(Security as unknown as GenericModel, 'mandiId', Mandi as unknown as GenericModel, 'mandiId', 'securities.mandiId');
  await assertReferences(Security as unknown as GenericModel, 'depositoryId', Depository as unknown as GenericModel, 'depositoryId', 'securities.depositoryId');
  await assertReferences(ExchangeOrder as unknown as GenericModel, 'brokerId', BrokerMember as unknown as GenericModel, 'brokerId', 'exchangeorders.brokerId');
  await assertReferences(ExchangeOrder as unknown as GenericModel, 'securityId', Security as unknown as GenericModel, 'securityId', 'exchangeorders.securityId');
  await assertReferences(Obligation as unknown as GenericModel, 'executionId', Execution as unknown as GenericModel, 'executionId', 'obligations.executionId');
  await assertReferences(CustodyTransfer as unknown as GenericModel, 'lotId', CustodyLot as unknown as GenericModel, 'lotId', 'custodytransfers.lotId');

  const malformedObligationGroups = await Obligation.aggregate([{ $group: { _id: '$executionId', count: { $sum: 1 } } }, { $match: { count: { $ne: 2 } } }, { $limit: 5 }]);
  if (malformedObligationGroups.length) errors.push(`Executions without exactly two obligations: ${malformedObligationGroups.map((item) => String(item._id)).join(', ')}`);
  if (!collections.includes('usersessions')) warnings.push('usersessions collection is absent because no sessions have been issued yet');

  const collectionCounts = Object.fromEntries(await Promise.all(collections.map(async (name) => [name, await database.collection(name).estimatedDocumentCount()] as const)));
  const report = { ok: errors.length === 0, database: mongoose.connection.name, users: users.length, collections: collectionCounts, warnings, errors };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
