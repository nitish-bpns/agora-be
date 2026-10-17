import mongoose, { type ClientSession } from 'mongoose';

export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => { result = await work(session); });
    if (result === undefined) throw new Error('Transaction completed without a result');
    return result;
  } finally {
    await session.endSession();
  }
}
