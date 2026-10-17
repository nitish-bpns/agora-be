import mongoose, { type AnyObject } from 'mongoose';
import { env } from '../config/env.js';
import { User, UserSession, type UserRole, type UserStatus, type UserType } from '../modules/auth/auth.model.js';

interface LegacyDocument extends AnyObject {
  userId?: string;
  traderId?: string;
  username?: string;
  displayName?: string;
  email?: string;
  passwordHash?: string;
  realm?: string;
  role?: string;
  isActive?: boolean;
  passwordChanged?: boolean;
  accountId?: string;
  status?: string;
  statusReason?: string;
  tokenHash?: string;
  createdAt?: Date;
  updatedAt?: Date;
  expiresAt?: Date;
  endedAt?: Date;
}

function requireText(value: unknown, field: string, collection: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${collection}.${field} is missing`);
  return value.trim();
}

function operatorType(realm: string): UserType {
  if (realm === 'Broker' || realm === 'Exchange' || realm === 'Storage') return realm;
  throw new Error(`Unsupported legacy operator realm: ${realm}`);
}

function operatorRole(role: string): UserRole {
  if (role === 'Admin' || role === 'Operations' || role === 'Read-only') return role;
  throw new Error(`Unsupported legacy operator role: ${role}`);
}

function traderStatus(status: string | undefined): UserStatus {
  if (status === 'Suspended' || status === 'Closed') return status;
  return 'Active';
}

async function collectionIfPresent(name: string): Promise<mongoose.mongo.Collection<LegacyDocument> | null> {
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB is not connected');
  const exists = await database.listCollections({ name }, { nameOnly: true }).hasNext();
  return exists ? database.collection<LegacyDocument>(name) : null;
}

async function assertUsernameAvailable(username: string, userId: string): Promise<void> {
  const existing = await User.findOne({ username }).lean();
  if (existing && existing.userId !== userId) throw new Error(`Username ${username} belongs to multiple legacy identities`);
}

await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
try {
  const operators = await collectionIfPresent('operators');
  const traders = await collectionIfPresent('traders');
  const traderSessions = await collectionIfPresent('tradersessions');
  const migratedUsernames = new Set<string>();

  for (const legacy of operators ? await operators.find({}).toArray() : []) {
    const userId = requireText(legacy.userId, 'userId', 'operators');
    const username = requireText(legacy.username, 'username', 'operators').toLowerCase();
    await assertUsernameAvailable(username, userId);
    const userType = operatorType(requireText(legacy.realm, 'realm', 'operators'));
    await User.collection.updateOne(
      { username },
      {
        $set: {
          userId,
          username,
          displayName: requireText(legacy.displayName, 'displayName', 'operators'),
          email: legacy.email ?? '',
          passwordHash: requireText(legacy.passwordHash, 'passwordHash', 'operators'),
          userType,
          role: operatorRole(requireText(legacy.role, 'role', 'operators')),
          status: legacy.isActive === false ? 'Inactive' : 'Active',
          statusReason: '',
          passwordChanged: legacy.passwordChanged ?? false,
          updatedAt: legacy.updatedAt ?? new Date()
        },
        $setOnInsert: { createdAt: legacy.createdAt ?? new Date() }
      },
      { upsert: true }
    );
    migratedUsernames.add(username);
  }

  for (const legacy of traders ? await traders.find({}).toArray() : []) {
    const userId = requireText(legacy.traderId, 'traderId', 'traders');
    const username = requireText(legacy.username, 'username', 'traders').toLowerCase();
    await assertUsernameAvailable(username, userId);
    await User.collection.updateOne(
      { username },
      {
        $set: {
          userId,
          username,
          displayName: requireText(legacy.displayName, 'displayName', 'traders'),
          email: legacy.email ?? '',
          passwordHash: requireText(legacy.passwordHash, 'passwordHash', 'traders'),
          userType: 'Trader',
          role: 'Trader',
          status: traderStatus(legacy.status),
          statusReason: legacy.statusReason ?? '',
          accountId: requireText(legacy.accountId, 'accountId', 'traders'),
          passwordChanged: true,
          updatedAt: legacy.updatedAt ?? new Date()
        },
        $setOnInsert: { createdAt: legacy.createdAt ?? new Date() }
      },
      { upsert: true }
    );
    migratedUsernames.add(username);
  }

  for (const legacy of traderSessions ? await traderSessions.find({}).toArray() : []) {
    const tokenHash = requireText(legacy.tokenHash, 'tokenHash', 'tradersessions');
    await UserSession.collection.updateOne(
      { tokenHash },
      {
        $set: {
          tokenHash,
          userId: requireText(legacy.traderId, 'traderId', 'tradersessions'),
          createdAt: legacy.createdAt ?? new Date(),
          expiresAt: legacy.expiresAt ?? new Date(),
          ...(legacy.endedAt ? { endedAt: legacy.endedAt } : {})
        }
      },
      { upsert: true }
    );
  }

  const migrated = await User.countDocuments({ username: { $in: [...migratedUsernames] } });
  if (migrated !== migratedUsernames.size) throw new Error(`Migration verification failed: expected ${migratedUsernames.size} users, found ${migrated}`);

  for (const collection of [operators, traders, traderSessions]) {
    if (collection) await collection.drop();
  }

  await User.syncIndexes();
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB is not connected');
  if (!(await database.listCollections({ name: 'usersessions' }, { nameOnly: true }).hasNext())) await database.createCollection('usersessions');
  const sessions = database.collection('usersessions');
  const expiryIndex = (await sessions.listIndexes().toArray()).find((index) => index.name === 'expiresAt_1');
  if (expiryIndex) await database.command({ collMod: 'usersessions', index: { name: 'expiresAt_1', expireAfterSeconds: 0 } });
  else await sessions.createIndex({ expiresAt: 1 }, { name: 'expiresAt_1', expireAfterSeconds: 0 });
  console.log(`Unified identity migration completed: ${migrated} users migrated; legacy identity collections removed.`);
} finally {
  await mongoose.disconnect();
}
