import type { Prisma, Transaction } from '@prisma/client';

export type Database = Prisma.TransactionClient;

export async function lockRecord(db: Database, namespace: string, id: string) {
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${namespace + ':' + id}, 0))`;
}

export function publicPayment<T extends Transaction>(row: T) {
  const { nextActionAt: _nextActionAt, amountMinor, ...payment } = row;
  return { ...payment, amountMinor: amountMinor.toString() };
}
