import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // App
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  APP_VERSION: z.string().default('1.0.0'),
  ADMIN_SECRET: z.string().min(1, 'ADMIN_SECRET is required'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Demo
  DEMO_MODE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  DEMO_WEBHOOK_URL: z.string().default(''),

  // Nomba API
  NOMBA_API_BASE_URL: z.string().min(1, 'NOMBA_API_BASE_URL is required'),
  NOMBA_CLIENT_ID: z.string().default(''),
  NOMBA_CLIENT_SECRET: z.string().default(''),
  NOMBA_ACCOUNT_ID: z.string().default(''),
  NOMBA_WEBHOOK_HMAC_SECRET: z.string().default(''),
  NOMBA_MOCK_MODE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // Encryption
  ENCRYPTION_KEY: z
    .string()
    .min(32, 'ENCRYPTION_KEY must be at least 32 characters'),
  // Rate limiting
  THROTTLE_ADMIN_LIMIT: z.coerce.number().default(10),
  THROTTLE_ADMIN_TTL: z.coerce.number().default(60000),
  THROTTLE_WEBHOOK_LIMIT: z.coerce.number().default(100),
  THROTTLE_WEBHOOK_TTL: z.coerce.number().default(60000),
  THROTTLE_API_LIMIT: z.coerce.number().default(300),
  THROTTLE_API_TTL: z.coerce.number().default(60000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const appConfig = parsed.data;

export type AppConfig = typeof appConfig;
