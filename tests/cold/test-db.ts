import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryReplSet | null = null;
let connected = false;

export async function startTestDatabase(): Promise<void> {
  if (connected) return;
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' }, binary: { version: '7.0.14' } });
  await mongoose.connect(mongod.getUri());
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
