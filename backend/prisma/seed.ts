import 'dotenv/config';
import { z } from 'zod';
import { createDatabase } from '../src/config/database.js';
import { hashPassword } from '../src/services/auth.js';
import { registerSchema } from '../src/validators/auth.js';

class SeedError extends Error {}

async function seed() {
  const config = z.object({
    DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
    SEED_ADMIN_EMAIL: registerSchema.shape.email,
    SEED_ADMIN_PASSWORD: registerSchema.shape.password,
  }).safeParse(process.env);
  if (!config.success) {
    const fields = config.error.issues.map(issue => issue.path.join('.')).join(', ');
    throw new SeedError(`Set valid values for ${fields} before seeding`);
  }

  const { DATABASE_URL, SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password } = config.data;
  const db = createDatabase(DATABASE_URL);
  try {
    const existing = await db.user.findUnique({ where: { email }, select: { role: true } });
    if (existing?.role === 'ADMIN') {
      console.log('Administrator already exists');
      return;
    }
    if (existing) throw new SeedError('The seed email belongs to an existing merchant');

    const passwordHash = await hashPassword(password);
    await db.$transaction(async tx => {
      const admin = await tx.user.create({
        data: { email, passwordHash, role: 'ADMIN' },
        select: { id: true },
      });
      await tx.auditLog.create({ data: { action: 'ADMIN_PROVISIONED', actorId: admin.id } });
    });
    console.log('Administrator provisioned');
  } finally {
    await db.$disconnect();
  }
}

seed().catch(error => {
  console.error(error instanceof SeedError ? error.message : 'Administrator provisioning failed');
  process.exitCode = 1;
});
