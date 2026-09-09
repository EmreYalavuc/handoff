interface QuickCode {
  code: string;
  roomId: string;
  hostId: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export class QuickSupportManager {
  private codes = new Map<string, QuickCode>();

  generate(roomId: string, hostId: string): QuickCode {
    const now = Date.now();
    // Cleanup expired before generating
    for (const [k, v] of this.codes.entries()) {
      if (v.expiresAt < now) this.codes.delete(k);
    }

    const code = this.makeCode();
    const entry: QuickCode = {
      code, roomId, hostId,
      createdAt: now,
      expiresAt: now + TTL_MS,
      used: false,
    };
    this.codes.set(code, entry);
    return entry;
  }

  redeem(code: string): { roomId: string; hostId: string } | null {
    const key = code.replace(/\s+/g, '');
    const entry = this.codes.get(key);
    if (!entry) return null;
    if (entry.used || entry.expiresAt < Date.now()) {
      this.codes.delete(key);
      return null;
    }
    entry.used = true;
    return { roomId: entry.roomId, hostId: entry.hostId };
  }

  /** Invalidate all codes belonging to a room (call when room closes). */
  invalidateRoom(roomId: string): void {
    for (const [k, v] of this.codes.entries()) {
      if (v.roomId === roomId) this.codes.delete(k);
    }
  }

  getRemainingMs(code: string): number {
    const entry = this.codes.get(code);
    if (!entry) return 0;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  private makeCode(): string {
    const digits = () => Math.floor(100 + Math.random() * 900).toString();
    let code: string;
    do { code = `${digits()}${digits()}`; } while (this.codes.has(code));
    return code;
  }
}
