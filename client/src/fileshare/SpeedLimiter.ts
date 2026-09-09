/**
 * Token-bucket rate limiter for upload speed control.
 * null = unlimited.
 */
export class SpeedLimiter {
  private tokens: number;
  private limitBps: number | null; // bytes per second; null = unlimited
  private lastRefill: number;

  constructor(limitBps: number | null = null) {
    this.limitBps = limitBps;
    this.tokens = limitBps ?? 0;
    this.lastRefill = performance.now();
  }

  setLimit(limitBps: number | null) {
    this.limitBps = limitBps;
    this.tokens = limitBps ?? 0;
    this.lastRefill = performance.now();
  }

  isUnlimited(): boolean { return this.limitBps === null; }

  /** Wait until `bytes` tokens are available. No-op if unlimited. */
  async consume(bytes: number): Promise<void> {
    if (this.limitBps === null) return;

    const now = performance.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.limitBps, this.tokens + elapsedSec * this.limitBps);
    this.lastRefill = now;

    if (this.tokens >= bytes) {
      this.tokens -= bytes;
    } else {
      const deficit = bytes - this.tokens;
      const waitMs = (deficit / this.limitBps) * 1000;
      this.tokens = 0;
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
}
