interface RateWindow {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, RateWindow>();

  /** Returns true if allowed; false if rate limit exceeded. */
  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= limit;
  }

  reset(key: string) {
    this.windows.delete(key);
  }

  /** Remove expired windows to prevent unbounded memory growth. */
  cleanup() {
    const now = Date.now();
    for (const [k, w] of this.windows.entries()) {
      if (now >= w.resetAt) this.windows.delete(k);
    }
  }
}
