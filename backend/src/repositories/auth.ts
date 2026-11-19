import { Prisma, type PrismaClient } from '@prisma/client';

const identityFields = {
  id: true,
  email: true,
  role: true,
  merchant: { select: { id: true, name: true } },
} satisfies Prisma.UserSelect;

export type Identity = Prisma.UserGetPayload<{ select: typeof identityFields }>;

export function createAuthRepository(db: PrismaClient) {
  return {
    findByEmail(email: string) {
      return db.user.findUnique({
        where: { email },
        select: { ...identityFields, passwordHash: true },
      });
    },

    findIdentity(id: string) {
      return db.user.findUnique({ where: { id }, select: identityFields });
    },

    register(merchantName: string, email: string, passwordHash: string) {
      return db.$transaction(async tx => {
        const merchant = await tx.merchant.create({ data: { name: merchantName } });
        const user = await tx.user.create({
          data: { email, passwordHash, merchantId: merchant.id },
          select: identityFields,
        });
        await tx.auditLog.create({
          data: { action: 'MERCHANT_REGISTERED', merchantId: merchant.id, actorId: user.id },
        });
        return user;
      });
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
