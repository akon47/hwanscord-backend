import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

export interface TestMongo {
  uri: string;
  stop(): Promise<void>;
}

/**
 * MongoDB for one test file.
 * - `TEST_MONGODB_URI` set (CI): use that server with a fresh, uniquely named database, dropped on stop.
 *   CI runs a `mongo:4.4` container because the Jenkins VM CPU has no AVX (MongoDB 5+ needs it).
 * - otherwise: an in-memory mongod from mongodb-memory-server.
 */
export async function startMongo(prefix: string): Promise<TestMongo> {
  const external = process.env.TEST_MONGODB_URI;
  const dbName = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  if (external) {
    const url = new URL(external);
    url.pathname = `/${dbName}`;
    return {
      uri: url.toString(),
      async stop() {
        if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
      },
    };
  }
  const mongod = await MongoMemoryServer.create({ instance: { dbName } });
  return {
    uri: mongod.getUri(dbName),
    async stop() {
      await mongod.stop();
    },
  };
}
