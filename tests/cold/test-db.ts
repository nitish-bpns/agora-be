import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

// Each test file runs in its own forked process (vitest `fileParallelism: false`
// + default isolation), so the process-global `mongoose` singleton and this
// module's `connected` flag are per-file.
let mongod: MongoMemoryReplSet | null = null;
let connected = false;

async function waitForPrimary(maxMs = 20_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const state = await mongoose.connection.db!.admin().command({ hello: 1 } as Record<string, unknown>);
      if ((state as { isWritablePrimary?: boolean }).isWritablePrimary) return;
    } catch {
      // primary not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Test replica set did not elect a primary in time');
}

export async function startTestDatabase(): Promise<void> {
  if (connected) return;
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri());
  // Transactions (used by inventory/pledge services) require an elected primary.
  await waitForPrimary();
  connected = true;
}

export async function stopTestDatabase(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
  mongod = null;
  connected = false;
}

export async function clearDatabase(): Promise<void> {
  await startTestDatabase();
  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}
