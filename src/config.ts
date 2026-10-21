import fs from 'node:fs';
import path from 'node:path';

export interface RateLimitConfig {
  enabled: boolean;
}

export interface Config {
  env: 'development' | 'production' | 'test';
  port: number;
  mongoUri: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  uploadDir: string;
  corsOrigins: string[];
  trustProxy: number | boolean;
  appVersion: string;
  logLevel: string;
  rateLimit: RateLimitConfig;
  turn: {
    keyId: string | undefined;
    apiToken: string | undefined;
    accountId: string | undefined;
    analyticsToken: string | undefined;
    monthlyBudgetGb: number;
    credentialTtl: number;
  };
  attachmentGcIntervalMs: number;
  publicUrl: string;
  github: {
    clientId: string | undefined;
    clientSecret: string | undefined;
    oauthBaseUrl: string;
    apiBaseUrl: string;
  };
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    return fs.readFileSync(file, 'utf8').trim() || undefined;
  }
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseTrustProxy(raw: string | undefined): number | boolean {
  if (raw === undefined || raw === '') return 1;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv =
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const jwtSecret =
    readSecret(env, 'JWT_SECRET') ??
    (nodeEnv === 'production' ? undefined : 'dev-only-insecure-secret-change-me-please');
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('JWT_SECRET (or JWT_SECRET_FILE) must be set and at least 32 characters long');
  }
  const corsOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    env: nodeEnv,
    port: Number(env.PORT ?? 8080),
    mongoUri: readSecret(env, 'MONGODB_URI') ?? 'mongodb://localhost:27017/hwanscord',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? '7d',
    uploadDir: path.resolve(env.UPLOAD_DIR ?? './data/uploads'),
    corsOrigins,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    appVersion: env.APP_VERSION ?? 'dev',
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    rateLimit: { enabled: env.RATE_LIMIT !== 'off' && nodeEnv !== 'test' },
    turn: {
      keyId: readSecret(env, 'CF_TURN_KEY_ID'),
      apiToken: readSecret(env, 'CF_TURN_API_TOKEN'),
      accountId: readSecret(env, 'CF_ACCOUNT_ID'),
      analyticsToken: readSecret(env, 'CF_ANALYTICS_TOKEN'),
      monthlyBudgetGb: Number(env.TURN_MONTHLY_BUDGET_GB ?? 800),
      credentialTtl: Number(env.TURN_CREDENTIAL_TTL ?? 86400),
    },
    attachmentGcIntervalMs: Number(env.ATTACHMENT_GC_INTERVAL_MS ?? 60 * 60 * 1000),
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    github: {
      clientId: readSecret(env, 'GITHUB_CLIENT_ID'),
      clientSecret: readSecret(env, 'GITHUB_CLIENT_SECRET'),
      oauthBaseUrl: (env.GITHUB_OAUTH_BASE_URL ?? 'https://github.com').replace(/\/+$/, ''),
      apiBaseUrl: (env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/+$/, ''),
    },
  };
}
