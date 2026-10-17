import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

export const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => void Promise.resolve(handler(req, res, next)).catch(next);

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

export function pagination(query: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  return { page, limit, skip: (page - 1) * limit };
}
