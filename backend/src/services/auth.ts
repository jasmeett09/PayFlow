import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AuthRepository, Identity } from '../repositories/auth.js';
import { ApiError } from '../utils/api-error.js';
import type { loginSchema, registerSchema } from '../validators/auth.js';

const issuer = 'payflow';
const audience = 'payflow-api';
const expiresIn = 15 * 60;
const passwordCost = 12;
const dummyHash = bcrypt.hashSync(randomBytes(32).toString('hex'), passwordCost);
const tokenSubject = z.uuid();

export function hashPassword(password: string) {
  return bcrypt.hash(password, passwordCost);
}

export function createAuthService(repository: AuthRepository, jwtSecret: string) {
  function session(user: Identity) {
    const accessToken = jwt.sign({}, jwtSecret, {
      algorithm: 'HS256',
      subject: user.id,
      issuer,
      audience,
      expiresIn,
    });
    return { user, accessToken, tokenType: 'Bearer', expiresIn };
  }

  return {
    async register({ merchantName, email, password }: z.infer<typeof registerSchema>) {
      const passwordHash = await hashPassword(password);
      try {
        return session(await repository.register(merchantName, email, passwordHash));
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ApiError(409, 'EMAIL_IN_USE', 'An account already uses this email');
        }
        throw error;
      }
    },

    async login({ email, password }: z.infer<typeof loginSchema>) {
      const result = await repository.findByEmail(email);
      const valid = await bcrypt.compare(password, result?.passwordHash ?? dummyHash);
      if (!result || !valid) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }
      return session({
        id: result.id,
        email: result.email,
        role: result.role,
        merchant: result.merchant,
      });
    },

    async authenticate(token: string) {
      const unauthorized = new ApiError(401, 'UNAUTHORIZED', 'A valid access token is required');
      let subject: string;
      try {
        const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer, audience });
        subject = tokenSubject.parse(typeof claims === 'string' ? undefined : claims.sub);
      } catch {
        throw unauthorized;
      }

      const user = await repository.findIdentity(subject);
      if (!user) throw unauthorized;
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
