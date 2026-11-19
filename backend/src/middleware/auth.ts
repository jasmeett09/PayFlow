import type { Role } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { Identity } from '../repositories/auth.js';
import type { AuthService } from '../services/auth.js';
import { ApiError } from '../utils/api-error.js';

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

export function authenticate(service: AuthService): RequestHandler {
  return async (req, _res, next) => {
    const token = /^Bearer ([^\s]+)$/i.exec(req.get('Authorization') ?? '')?.[1];
    if (!token) throw new ApiError(401, 'UNAUTHORIZED', 'A valid access token is required');
    req.identity = await service.authenticate(token);
    next();
  };
}

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.identity) throw new ApiError(401, 'UNAUTHORIZED', 'A valid access token is required');
    if (!allowed.includes(req.identity.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have access to this resource');
    }
    next();
  };
}
