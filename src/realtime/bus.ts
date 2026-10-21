import type { Server } from 'socket.io';
import type { IChannel } from '../models/Channel.js';
import { idToString } from '../lib/ids.js';

export type ChannelAudience = Pick<IChannel, 'type' | 'participants'>;

/** Thin wrapper over socket.io that knows who should receive channel-scoped events. */
export class Realtime {
  constructor(private readonly io: Server) {}

  emitAll(event: string, payload: unknown): void {
    this.io.emit(event, payload);
  }

  emitToUsers(userIds: readonly string[], event: string, payload: unknown): void {
    const rooms = [...new Set(userIds)].map((id) => `user:${id}`);
    if (rooms.length === 0) return;
    this.io.to(rooms).emit(event, payload);
  }

  /** Drops every live socket of a user (their sessions were invalidated). */
  disconnectUser(userId: string): void {
    this.io.in(`user:${userId}`).disconnectSockets(true);
  }

  emitToSocket(socketId: string, event: string, payload: unknown): void {
    this.io.to(socketId).emit(event, payload);
  }

  /** DM events go to the two participants only; everything else to everybody. */
  emitForChannel(channel: ChannelAudience, event: string, payload: unknown): void {
    if (channel.type === 'dm') {
      this.emitToUsers(
        channel.participants.map((p) => idToString(p) as string),
        event,
        payload,
      );
    } else {
      this.emitAll(event, payload);
    }
  }

  get server(): Server {
    return this.io;
  }
}
