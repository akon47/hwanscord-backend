import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string, pretty = false): Logger {
  if (pretty) {
    return pino({
      level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
    });
  }
  return pino({ level });
}
