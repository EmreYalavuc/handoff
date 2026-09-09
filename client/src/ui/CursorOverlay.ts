interface RemoteCursor {
  el: HTMLElement;
  lastSeen: number;
}

const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];

/** Renders remote cursors as labelled dots over the video container. HOST-side. */
export class CursorOverlay {
  private container: HTMLElement;
  private cursors = new Map<string, RemoteCursor>();
  private colorMap = new Map<string, string>();
  private colorIndex = 0;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    // Clean up stale cursors
    this.cleanupTimer = setInterval(() => this.cleanup(), 3000);
  }

  updateCursor(viewerId: string, viewerName: string, normalizedX: number, normalizedY: number) {
    let cursor = this.cursors.get(viewerId);
    if (!cursor) {
      cursor = this.buildCursor(viewerId, viewerName);
      this.cursors.set(viewerId, cursor);
    }

    const rect = this.container.getBoundingClientRect();
    const x = normalizedX * this.container.clientWidth;
    const y = normalizedY * this.container.clientHeight;
    cursor.el.style.transform = `translate(${x}px, ${y}px)`;
    cursor.el.style.opacity = '1';
    cursor.lastSeen = Date.now();
  }

  removeCursor(viewerId: string) {
    const cursor = this.cursors.get(viewerId);
    if (!cursor) return;
    cursor.el.remove();
    this.cursors.delete(viewerId);
  }

  destroy() {
    clearInterval(this.cleanupTimer);
    for (const c of this.cursors.values()) c.el.remove();
    this.cursors.clear();
  }

  private buildCursor(viewerId: string, name: string): RemoteCursor {
    if (!this.colorMap.has(viewerId)) {
      this.colorMap.set(viewerId, COLORS[this.colorIndex++ % COLORS.length]);
    }
    const color = this.colorMap.get(viewerId)!;

    const el = document.createElement('div');
    el.className = 'remote-cursor';
    el.innerHTML = `
      <svg class="cursor-arrow" width="16" height="16" viewBox="0 0 16 16">
        <path d="M0 0 L0 12 L3.5 8.5 L6 14 L8 13 L5.5 7 L10 7 Z" fill="${color}" stroke="#0008" stroke-width="0.5"/>
      </svg>
      <span class="cursor-label" style="background:${color}">${name}</span>
    `;
    this.container.appendChild(el);
    return { el, lastSeen: Date.now() };
  }

  private cleanup() {
    const stale = Date.now() - 5000;
    for (const [id, cursor] of this.cursors.entries()) {
      if (cursor.lastSeen < stale) {
        cursor.el.style.opacity = '0';
        if (cursor.lastSeen < stale - 2000) {
          cursor.el.remove();
          this.cursors.delete(id);
        }
      }
    }
  }
}
