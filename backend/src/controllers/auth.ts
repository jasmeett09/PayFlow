import type { RequestHandler } from 'express';
import type { AuthService } from '../services/auth.js';
import { loginSchema, registerSchema } from '../validators/auth.js';

export function createAuthController(service: AuthService) {
  const register: RequestHandler = async (req, res) => {
    const data = await service.register(registerSchema.parse(req.body));
    res.status(201).json({ data });
  };

  const login: RequestHandler = async (req, res) => {
    const data = await service.login(loginSchema.parse(req.body));
    res.json({ data });
  };

  const me: RequestHandler = (req, res) => {
    res.json({ data: req.identity });
  };

  return { register, login, me };
}
