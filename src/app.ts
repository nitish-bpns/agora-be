import compression from 'compression';
import cors from 'cors';
import express, { type RequestHandler } from 'express';
import * as helmetModule from 'helmet';
import type { HelmetOptions } from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFound } from './common/errors.js';
import { createRateLimit } from './common/rate-limit.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { brokerRouter, traderRouter } from './modules/broker/broker.routes.js';
import { deskRouter } from './modules/desk/desk.routes.js';
import { exchangeMemberRouter, exchangeRouter } from './modules/exchange/exchange.routes.js';
import { storageRouter } from './modules/storage/storage.routes.js';

const helmet = helmetModule.default as unknown as (options?: HelmetOptions) => RequestHandler;

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(pinoHttp({ logger }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: '*', credentials: false }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(createRateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : 300 }));
  app.get(['/', '/health', '/api/v1/health'], (_req, res) => res.json({
    status: 'ok',
    service: 'agora-api',
    version: '1.0.0',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    apiBase: '/api/v1'
  }));
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/audit', auditRouter);
  app.use('/api/v1/exchange/member', exchangeMemberRouter);
  app.use('/api/v1/exchange', exchangeRouter);
  app.use('/api/v1/broker', brokerRouter);
  app.use('/api/v1/trader', traderRouter);
  app.use('/api/v1/desk', deskRouter);
  app.use('/api/v1/storage', storageRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
