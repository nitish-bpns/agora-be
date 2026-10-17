import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'REQUEST_FAILED', public readonly details?: unknown) {
    super(message);
  }
}

export const notFound: RequestHandler = (req, _res, next) => next(new ApiError(404, `Route ${req.method} ${req.path} was not found`, 'NOT_FOUND'));

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.flatten() } });
    return;
  }
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same unique value already exists' } });
    return;
  }
  logger.error({ err: error }, 'Unhandled request error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};
