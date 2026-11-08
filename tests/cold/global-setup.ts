import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | null = null;

export default async function setup({ provide }: { provide: (key: string, value: unknown) => void }): Promise<(() => Promise<void>) | undefined> {
  mongod = await MongoMemoryServer.create({
    instance: { replSet: 'testset' },
    binary: { version: '7.0.14' }
  });
  provide('coldMongoUri', mongod.getUri());
  return async () => {
    if (mongod) await mongod.stop();
    mongod = null;
  };
}
