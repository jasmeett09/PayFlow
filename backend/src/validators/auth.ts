import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

const passwordSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, 'utf8') <= 72 && !value.includes('\0'),
  'Password must be at most 72 UTF-8 bytes and contain no null character',
);

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
});

export const registerSchema = loginSchema.extend({
  merchantName: z.string().trim().min(1).refine(
    value => [...value].length <= 120 && !value.includes('\0'),
    'Merchant name must be at most 120 characters and contain no null character',
  ),
  password: passwordSchema.refine(value => [...value].length >= 12, 'Use at least 12 characters'),
});
