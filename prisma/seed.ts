import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { encrypt, deriveKey } from '../src/common/utils/crypto.utils';

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

  // Derive the encryption key from ENCRYPTION_KEY (same logic as AuthService)
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) {
    console.warn(
      '⚠️  ENCRYPTION_KEY not set — Nomba secrets will NOT be encrypted at rest in seed data',
    );
  }
  const encKey = ENCRYPTION_KEY ? deriveKey(ENCRYPTION_KEY) : null;

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
      ...(envVars.NOMBA_CLIENT_SECRET &&
        encKey && {
          nombaClientSecret: encrypt(envVars.NOMBA_CLIENT_SECRET, encKey),
        }),
      ...(envVars.NOMBA_WEBHOOK_HMAC_SECRET &&
        encKey && {
          nombaWebhookSecret: encrypt(
            envVars.NOMBA_WEBHOOK_HMAC_SECRET,
            encKey,
          ),
        }),
    },
    create: {
      name: 'Hackathon Judges',
      email: 'judges@accountos.demo',
      nombaAccountId: envVars.NOMBA_ACCOUNT_ID ?? null,
      nombaSubAccountId: envVars.NOMBA_SUB_ACCOUNT_ID ?? null,
      nombaClientId: envVars.NOMBA_CLIENT_ID ?? null,
      nombaClientSecret:
        envVars.NOMBA_CLIENT_SECRET && encKey
          ? encrypt(envVars.NOMBA_CLIENT_SECRET, encKey)
          : null,
      nombaWebhookSecret:
        envVars.NOMBA_WEBHOOK_HMAC_SECRET && encKey
          ? encrypt(envVars.NOMBA_WEBHOOK_HMAC_SECRET, encKey)
          : null,
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

  // ── Seed a couple of logical treasury buckets (no Nomba DVA) ─────────────
  // Buckets are internal sub-ledgers — see technical-docs/TREASURY_BUILD.md.
  const buckets: Array<{
    bucketRef: string;
    name: string;
    bucketType: 'PAYROLL' | 'TAX_RESERVE' | 'SAVINGS';
  }> = [
    { bucketRef: 'payroll', name: 'Payroll Pool', bucketType: 'PAYROLL' },
    {
      bucketRef: 'tax-reserve',
      name: 'Tax Reserve',
      bucketType: 'TAX_RESERVE',
    },
    { bucketRef: 'savings', name: 'Savings', bucketType: 'SAVINGS' },
  ];

  for (const b of buckets) {
    await prisma.treasuryBucket.upsert({
      where: {
        businessId_bucketRef: {
          businessId: business.id,
          bucketRef: b.bucketRef,
        },
      },
      update: { name: b.name, bucketType: b.bucketType },
      create: {
        bucketRef: b.bucketRef,
        name: b.name,
        bucketType: b.bucketType,
        businessId: business.id,
      },
    });
  }

  console.log(`✅ Seeded ${buckets.length} treasury buckets`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
