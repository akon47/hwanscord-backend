import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import pino from 'pino';
import supertest from 'supertest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { ensureUploadDirs } from '../src/services/files.js';

export interface TestApp {
  built: BuiltApp;
  config: Config;
  api: supertest.Agent;
  baseUrl: string;
  port: number;
  mongod: MongoMemoryServer;
  uploadDir: string;
  stop(): Promise<void>;
  reset(): Promise<void>;
}

export interface Session {
  token: string;
  user: { id: string; username: string; displayName: string; role: string };
}

export async function startTestApp(
  extraEnv: NodeJS.ProcessEnv = {},
  fetchImpl?: typeof fetch,
): Promise<TestApp> {
  const mongod = await MongoMemoryServer.create({ instance: { dbName: 'hwanscord-test' } });
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwanscord-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: mongod.getUri('hwanscord-test'),
    JWT_SECRET: 'test-secret-test-secret-test-secret-test-secret',
    UPLOAD_DIR: uploadDir,
    LOG_LEVEL: 'silent',
    ...extraEnv,
  });
  await ensureUploadDirs(uploadDir);
  await mongoose.connect(config.mongoUri);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const built = buildApp(config, { logger: pino({ level: 'silent' }), fetchImpl });
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  const { port } = built.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    built,
    config,
    api: supertest(built.server),
    baseUrl,
    port,
    mongod,
    uploadDir,
    async reset() {
      await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
    },
    async stop() {
      await built.close();
      await mongoose.disconnect();
      await mongod.stop();
      await fs.rm(uploadDir, { recursive: true, force: true });
    },
  };
}

export async function register(app: TestApp, username: string, displayName?: string): Promise<Session> {
  const res = await app.api
    .post('/api/v1/auth/register')
    .send({ username, password: `${username}-password-1`, displayName })
    .expect(201);
  return { token: res.body.token, user: res.body.user };
}

export function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

export async function createChannel(
  app: TestApp,
  token: string,
  name: string,
  type: 'text' | 'voice' = 'text',
) {
  const res = await app.api.post('/api/v1/channels').set(auth(token)).send({ type, name }).expect(201);
  return res.body.channel as { id: string; type: string; name: string };
}

export async function sendMessage(
  app: TestApp,
  token: string,
  channelId: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const res = await app.api
    .post(`/api/v1/channels/${channelId}/messages`)
    .set(auth(token))
    .send({ content, ...extra })
    .expect(201);
  return res.body.message as { id: string; content: string; channelId: string; [k: string]: unknown };
}

export function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000, intervalMs = 20): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
