import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';

await connectDatabase();
const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT }, 'Agora API listening'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Graceful shutdown started');
  server.close(async () => { await disconnectDatabase(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
