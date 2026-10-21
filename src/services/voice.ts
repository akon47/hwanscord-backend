export interface VoiceMember {
  userId: string;
  socketId: string;
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
}

export interface VoiceState {
  channelId: string;
  members: VoiceMember[];
}

/** In-memory voice channel membership, keyed by socket (one user may sit in several tabs). */
export class VoiceService {
  private readonly channels = new Map<string, Map<string, VoiceMember>>();
  private readonly bySocket = new Map<string, string>();

  state(channelId: string): VoiceState {
    const members = this.channels.get(channelId);
    return { channelId, members: members ? [...members.values()].map((m) => ({ ...m })) : [] };
  }

  allStates(): VoiceState[] {
    return [...this.channels.keys()].map((id) => this.state(id)).filter((s) => s.members.length > 0);
  }

  channelOf(socketId: string): string | undefined {
    return this.bySocket.get(socketId);
  }

  member(socketId: string): VoiceMember | undefined {
    const channelId = this.bySocket.get(socketId);
    if (!channelId) return undefined;
    return this.channels.get(channelId)?.get(socketId);
  }

  /** @returns channel ids whose state changed (previous channel first, if any) */
  join(channelId: string, socketId: string, userId: string): string[] {
    const changed: string[] = [];
    const previous = this.bySocket.get(socketId);
    if (previous === channelId) return changed;
    if (previous) {
      this.leave(socketId);
      changed.push(previous);
    }
    let members = this.channels.get(channelId);
    if (!members) {
      members = new Map();
      this.channels.set(channelId, members);
    }
    members.set(socketId, { userId, socketId, muted: false, deafened: false, streaming: false });
    this.bySocket.set(socketId, channelId);
    changed.push(channelId);
    return changed;
  }

  /** @returns the channel the socket left, if it was in one */
  leave(socketId: string): string | undefined {
    const channelId = this.bySocket.get(socketId);
    if (!channelId) return undefined;
    this.bySocket.delete(socketId);
    const members = this.channels.get(channelId);
    members?.delete(socketId);
    if (members && members.size === 0) this.channels.delete(channelId);
    return channelId;
  }

  update(
    socketId: string,
    patch: Partial<Pick<VoiceMember, 'muted' | 'deafened' | 'streaming'>>,
  ): string | undefined {
    const channelId = this.bySocket.get(socketId);
    if (!channelId) return undefined;
    const member = this.channels.get(channelId)?.get(socketId);
    if (!member) return undefined;
    if (patch.muted !== undefined) member.muted = patch.muted;
    if (patch.deafened !== undefined) member.deafened = patch.deafened;
    if (patch.streaming !== undefined) member.streaming = patch.streaming;
    return channelId;
  }

  sameChannel(a: string, b: string): boolean {
    const ca = this.bySocket.get(a);
    return ca !== undefined && ca === this.bySocket.get(b);
  }

  /** Remove every member of a channel (channel deleted). @returns the kicked socket ids */
  clearChannel(channelId: string): string[] {
    const members = this.channels.get(channelId);
    if (!members) return [];
    const ids = [...members.keys()];
    for (const id of ids) this.bySocket.delete(id);
    this.channels.delete(channelId);
    return ids;
  }
}
