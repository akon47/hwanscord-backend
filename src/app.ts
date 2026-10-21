import http from 'node:http';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { Server } from 'socket.io';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createLogger, type Logger } from './logger.js';
import { errorHandler, notFoundHandler } from './http/middleware/errors.js';
import { attachmentsRoutes } from './http/routes/attachments.js';
import { authRoutes } from './http/routes/auth.js';
import { channelsRoutes, readStatesRoutes } from './http/routes/channels.js';
import { healthRoutes } from './http/routes/health.js';
import { messagesRoutes, searchRoutes } from './http/routes/messages.js';
import { rtcRoutes } from './http/routes/rtc.js';
import { usersRoutes } from './http/routes/users.js';
import { uploadsStatic } from './http/uploads.js';
import { Realtime } from './realtime/bus.js';
import { registerGateway, type AppServer } from './realtime/gateway.js';
import { PresenceService } from './services/presence.js';
import { TurnService } from './services/turn.js';
import { VoiceService } from './services/voice.js';

export interface BuildOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface BuiltApp {
  app: Express;
  server: http.Server;
  io: AppServer;
  ctx: AppContext;
  close(): Promise<void>;
}

export function buildApp(config: Config, options: BuildOptions = {}): BuiltApp {
  const logger = options.logger ?? createLogger(config.logLevel, config.env === 'development');
  const app = express();
  const server = http.createServer(app);
  const io: AppServer = new Server(server, {
    path: '/socket.io/',
    serveClient: false,
    maxHttpBufferSize: 1e6,
    ...(config.corsOrigins.length > 0 ? { cors: { origin: config.corsOrigins, credentials: true } } : {}),
  });

  const ctx: AppContext = {
    config,
    logger,
    presence: new PresenceService(),
    voice: new VoiceService(),
    turn: new TurnService(config.turn, logger, options.fetchImpl),
    realtime: new Realtime(io),
  };

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins, credentials: true }));
  }
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' || (req.url?.startsWith('/uploads/') ?? false) },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRoutes(ctx));
  app.use('/uploads', uploadsStatic(config.uploadDir));
  app.use('/api/v1/auth', authRoutes(ctx));
  app.use('/api/v1/users', usersRoutes(ctx));
  app.use('/api/v1/channels/:id/messages', messagesRoutes(ctx));
  app.use('/api/v1/channels', channelsRoutes(ctx));
  app.use('/api/v1/messages', searchRoutes(ctx));
  app.use('/api/v1/read-states', readStatesRoutes(ctx));
  app.use('/api/v1/attachments', attachmentsRoutes(ctx));
  app.use('/api/v1/rtc', rtcRoutes(ctx));
  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  registerGateway(io, ctx);

  return {
    app,
    server,
    io,
    ctx,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => resolve());
      }),
  };
}
