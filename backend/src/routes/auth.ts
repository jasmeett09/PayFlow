import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createAuthController } from '../controllers/auth.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import type { AuthService } from '../services/auth.js';
import { ApiError } from '../utils/api-error.js';

export function createAuthRouter(service: AuthService) {
  const router = Router();
  const controller = createAuthController(service);
  const limitCredentials = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Try again later')),
  });

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const parseCredentials = json({ limit: '16kb' });
  router.post('/register', limitCredentials, parseCredentials, controller.register);
  router.post('/login', limitCredentials, parseCredentials, controller.login);
  router.get('/me', authenticate(service), requireRole('ADMIN', 'MERCHANT'), controller.me);

  return router;
}
