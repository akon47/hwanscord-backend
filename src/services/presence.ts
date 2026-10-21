import type { UserStatus } from '../models/User.js';
import type { Presence } from '../lib/serialize.js';

/**
 * In-memory presence: which users currently have at least one live socket.
 * A single API process serves the whole community, so no shared store is needed.
 */
export class PresenceService {
  private readonly sockets = new Map<string, Set<string>>();

  /** @returns true when this was the user's first socket */
  add(userId: string, socketId: string): boolean {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    const first = set.size === 0;
    set.add(socketId);
    return first;
  }

  /** @returns true when this was the user's last socket */
  remove(userId: string, socketId: string): boolean {
    const set = this.sockets.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size === 0) {
      this.sockets.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }

  onlineUserIds(): string[] {
    return [...this.sockets.keys()];
  }

  socketIds(userId: string): string[] {
    return [...(this.sockets.get(userId) ?? [])];
  }

  /**
   * Effective presence as seen by `viewerId`. Invisible users look offline to others.
   * The user themself sees their chosen status (invisible → shown as 'online' so the UI
   * still reflects they are connected; the client uses `status` for the picker).
   */
  effective(userId: string, status: UserStatus, viewerId?: string): Presence {
    if (!this.isOnline(userId)) return 'offline';
    if (status === 'invisible') return viewerId === userId ? 'online' : 'offline';
    return status;
  }
}
