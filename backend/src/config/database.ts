import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export function createDatabase(connectionString: string) {
  const url = new URL(connectionString);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }, { schema }),
  });
}
