import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  // ── Read Nomba credentials from environment ──────────────────────────
  const envVars = {
    NOMBA_ACCOUNT_ID: process.env.NOMBA_ACCOUNT_ID,
    NOMBA_SUB_ACCOUNT_ID: process.env.NOMBA_SUB_ACCOUNT_ID,
    NOMBA_CLIENT_ID: process.env.NOMBA_CLIENT_ID,
    NOMBA_CLIENT_SECRET: process.env.NOMBA_CLIENT_SECRET,
    NOMBA_WEBHOOK_HMAC_SECRET: process.env.NOMBA_WEBHOOK_HMAC_SECRET,
  } as const;

  const missing: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    if (!value) {
      console.warn(
        `⚠️  ${key} not set — proceeding without live Nomba credentials`,
      );
      missing.push(key);
    }
  }

  // ── Upsert the Hackathon Judges business ─────────────────────────────
  const business = await prisma.business.upsert({
    where: { email: 'judges@accountos.demo' },
    update: {
      name: 'Hackathon Judges',
      ...(envVars.NOMBA_ACCOUNT_ID && {
        nombaAccountId: envVars.NOMBA_ACCOUNT_ID,
      }),
      ...(envVars.NOMBA_SUB_ACCOUNT_ID && {
        nombaSubAccountId: envVars.NOMBA_SUB_ACCOUNT_ID,
      }),
      ...(envVars.NOMBA_CLIENT_ID && {
        nombaClientId: envVars.NOMBA_CLIENT_ID,
      }),
      ...(envVars.NOMBA_CLIENT_SECRET && {
        nombaClientSecret: envVars.NOMBA_CLIENT_SECRET,
      }),
      ...(envVars.NOMBA_WEBHOOK_HMAC_SECRET && {
        nombaWebhookSecret: envVars.NOMBA_WEBHOOK_HMAC_SECRET,
      }),
    },
    create: {
      name: 'Hackathon Judges',
      email: 'judges@accountos.demo',
      nombaAccountId: envVars.NOMBA_ACCOUNT_ID ?? null,
      nombaSubAccountId: envVars.NOMBA_SUB_ACCOUNT_ID ?? null,
      nombaClientId: envVars.NOMBA_CLIENT_ID ?? null,
      nombaClientSecret: envVars.NOMBA_CLIENT_SECRET ?? null,
      nombaWebhookSecret: envVars.NOMBA_WEBHOOK_HMAC_SECRET ?? null,
    },
  });

  console.log('✅ Hackathon Judges business created with ID:', business.id);

  // ── Generate a non-expiring API key ──────────────────────────────────
  const secret = crypto.randomBytes(32).toString('hex');
  const rawKey = `acctos_live_${secret}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 20);

  // Revoke any existing key named "Judges Key" first (clean slate)
  await prisma.apiKey.updateMany({
    where: { businessId: business.id, name: 'Judges Key', revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await prisma.apiKey.create({
    data: {
      keyHash,
      keyPrefix,
      name: 'Judges Key',
      businessId: business.id,
      // expiresAt intentionally omitted — non-expiring
    },
  });

  console.log('=== JUDGE API KEY ===');
  console.log(rawKey);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
