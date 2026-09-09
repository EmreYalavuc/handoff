import { randomBytes } from 'crypto';

interface ControlEntry {
  viewerId: string;
  roomId: string;
  issuedAt: number;
}

export class ControlTokenManager {
  private tokens = new Map<string, ControlEntry>();

  /** Issue a new token, revoking any prior token for this viewer+room pair. */
  issue(viewerId: string, roomId: string): string {
    this.revokeByViewer(viewerId, roomId);
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, { viewerId, roomId, issuedAt: Date.now() });
    return token;
  }

  validate(token: string): ControlEntry | null {
    return this.tokens.get(token) ?? null;
  }

  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  revokeByViewer(viewerId: string, roomId: string): void {
    for (const [token, entry] of this.tokens.entries()) {
      if (entry.viewerId === viewerId && entry.roomId === roomId) {
        this.tokens.delete(token);
      }
    }
  }

  revokeByRoom(roomId: string): void {
    for (const [token, entry] of this.tokens.entries()) {
      if (entry.roomId === roomId) this.tokens.delete(token);
    }
  }

  hasActiveToken(viewerId: string, roomId: string): boolean {
    for (const entry of this.tokens.values()) {
      if (entry.viewerId === viewerId && entry.roomId === roomId) return true;
    }
    return false;
  }
}
