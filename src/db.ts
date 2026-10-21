import mongoose from 'mongoose';
import type { Logger } from './logger.js';

export async function connectDb(uri: string, logger?: Logger): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger?.info({ db: conn.connection.name }, 'mongodb connected');
  conn.connection.on('error', (err) => logger?.error({ err }, 'mongodb error'));
  conn.connection.on('disconnected', () => logger?.warn('mongodb disconnected'));
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbState(): 'connected' | 'disconnected' {
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}
