import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { createLogger } from './logger.js';
import { startAttachmentGc } from './services/attachments.js';
import { ensureUploadDirs } from './services/files.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.env === 'development');

  await ensureUploadDirs(config.uploadDir);
  await connectDb(config.mongoUri, logger);

  const built = buildApp(config, { logger });
  const stopGc = startAttachmentGc(config.uploadDir, config.attachmentGcIntervalMs, logger);

  await new Promise<void>((resolve) => built.server.listen(config.port, resolve));
  logger.info({ port: config.port, version: config.appVersion, env: config.env }, 'hwanscord api listening');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    stopGc();
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    try {
      await built.close();
      await disconnectDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
