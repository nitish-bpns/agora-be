import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { env } from '../config/env.js';
import { nextId } from '../common/ids.js';
import { User, UserSession } from '../modules/auth/auth.model.js';
import { hashPassword } from '../modules/auth/auth.service.js';
import { BrokerProfile } from '../modules/broker/broker.models.js';
import { BrokerConnection, DeskAccount, DeskInstrument, DeskPrice } from '../modules/desk/desk.models.js';
import { BrokerMember, Depository, Instrument, Mandi, Security } from '../modules/exchange/exchange.models.js';
import { Vault } from '../modules/storage/storage.models.js';

function bootstrapPassword(): string {
  const value = process.env.BOOTSTRAP_USER_PASSWORD;
  if (!value || value.length < 8) throw new Error('BOOTSTRAP_USER_PASSWORD must contain at least 8 characters when seeding users');
  return value;
}
const STANDARD_PASSWORD = bootstrapPassword();
const STANDARD_OPERATORS = [
  { realm: 'Broker', username: 'broker@agora.com', displayName: 'Broker' },
  { realm: 'Exchange', username: 'exchange@agora.com', displayName: 'Exchange' },
  { realm: 'Storage', username: 'storage@agora.com', displayName: 'Storage' }
] as const;
const STANDARD_TRADER = { username: 'trader@agora.com', displayName: 'Trader', email: 'trader@agora.com' } as const;

async function ensureOperator(input: (typeof STANDARD_OPERATORS)[number]): Promise<void> {
  const existing = await User.findOne({ username: input.username }).select('+passwordHash');
  if (existing) {
    existing.displayName = input.displayName;
    existing.userType = input.realm;
    existing.role = 'Admin';
    existing.status = 'Active';
    existing.statusReason = '';
    await existing.save();
    return;
  }
  const passwordHash = await hashPassword(STANDARD_PASSWORD);
  await User.create({ userId: await nextId('user'), username: input.username, displayName: input.displayName, userType: input.realm, role: 'Admin', status: 'Active', passwordChanged: true, passwordHash });
}

async function ensureTrader(): Promise<InstanceType<typeof User>> {
  const existing = await User.findOne({ username: STANDARD_TRADER.username }).select('+passwordHash');
  if (existing) {
    existing.displayName = STANDARD_TRADER.displayName;
    existing.email = STANDARD_TRADER.email;
    existing.userType = 'Trader';
    existing.role = 'Trader';
    existing.status = 'Active';
    existing.statusReason = '';
    await existing.save();
    await UserSession.updateMany({ userId: existing.userId, endedAt: { $exists: false } }, { $set: { endedAt: new Date() } });
    return existing;
  }
  const passwordHash = await hashPassword(STANDARD_PASSWORD);
  return User.create({ userId: await nextId('trader'), accountId: await nextId('account'), ...STANDARD_TRADER, userType: 'Trader', role: 'Trader', status: 'Active', passwordChanged: true, passwordHash });
}

await connectDatabase();
try {
  await User.deleteMany({ username: { $in: ['exchange-admin', 'broker-admin', 'storage-admin', 'desk-admin'] } });
  for (const operator of STANDARD_OPERATORS) await ensureOperator(operator);
  const trader = await ensureTrader();

  await DeskAccount.updateOne(
    { accountId: trader.accountId },
    { $set: { accountId: trader.accountId, label: 'Trader Account', traderId: trader.userId, brokerConnectionId: 'BRC-LOCAL', active: true } },
    { upsert: true }
  );
  await BrokerConnection.updateOne(
    { connectionId: 'BRC-LOCAL' },
    { $setOnInsert: { connectionId: 'BRC-LOCAL', label: 'Default Broker', isDefault: true } },
    { upsert: true }
  );

  if (env.SEED_DEMO_DATA && !(await Mandi.exists({ code: 'DEMO' }))) {
    const mandiId = await nextId('mandi');
    const depositoryId = await nextId('depository');
    const instrumentId = await nextId('instrument');
    const securityId = await nextId('security');
    const brokerId = await nextId('broker');
    await Mandi.create({ mandiId, code: 'DEMO', name: 'Demo Mandi', region: 'Sandbox', currency: 'USD', timezone: 'UTC' });
    await Depository.create({ depositoryId, code: 'DVAULT', name: 'Demo Vault', mandiId, assetClasses: ['Equity'] });
    await Vault.create({ depositoryId, name: 'Demo Vault' });
    await Instrument.create({ instrumentId, name: 'Agora Demo Security', isin: 'DEMO00000001', assetType: 'Equity', currency: 'USD' });
    await Security.create({ securityId, instrumentId, symbol: 'AGORA', mandiId, tickSize: 0.01, lotSize: 1, priceBandPct: 20, referencePrice: 100, settlementDays: 2, depositoryId });
    const crypto = await import('node:crypto');
    const apiKey = `bkr_${crypto.randomBytes(32).toString('base64url')}`;
    await BrokerMember.create({ brokerId, code: 'DEMOBKR', name: 'Demo Broker', mandiId, apiKeyHash: crypto.createHash('sha256').update(apiKey).digest('hex'), apiKeyPrefix: apiKey.slice(0, 12) });
    await BrokerProfile.create({ profileId: 'default', exchangeBrokerId: brokerId, mandiId });
    await DeskInstrument.create({ instrumentId: securityId, symbol: 'AGORA', name: 'Agora Demo Security', currency: 'USD', mandiId });
    await DeskPrice.create({ instrumentId: securityId, price: 100, effectiveDate: new Date().toISOString().slice(0, 10) });
    console.log(`Demo broker exchange API key (shown once): ${apiKey}`);
  }
  console.log('Standard Trader, Broker, Exchange, and Storage users are ready.');
} finally {
  await disconnectDatabase();
}
