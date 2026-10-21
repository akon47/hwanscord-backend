import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Realtime } from './realtime/bus.js';
import type { PresenceService } from './services/presence.js';
import type { TurnService } from './services/turn.js';
import type { VoiceService } from './services/voice.js';

export interface AppContext {
  config: Config;
  logger: Logger;
  presence: PresenceService;
  voice: VoiceService;
  turn: TurnService;
  realtime: Realtime;
}
