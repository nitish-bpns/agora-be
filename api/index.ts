import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/config/database.js';

const app = createApp();
let connectionPromise: Promise<void> | undefined;

async function ensureDatabase(): Promise<void> {
  if (mongoose.connection.readyState === mongoose.STATES.connected) return;
  connectionPromise ??= connectDatabase().catch((error: unknown) => {
    connectionPromise = undefined;
    throw error;
  });
  await connectionPromise;
}

export default async function handler(req: Request, res: Response): Promise<void> {
  await ensureDatabase();
  app(req, res);
}
