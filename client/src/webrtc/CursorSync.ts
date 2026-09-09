import { makeDCMessage, type DCMessage, type CursorPos } from './DataChannelProtocol';

type DCsender = (msg: DCMessage) => void;

/**
 * VIEWER side: captures mouse position over video element and sends it.
 * HOST side: CursorOverlay (UI component) renders the remote cursor.
 */
export class CursorSync {
  private el: HTMLElement;
  private send: DCsender;
  private active = false;
  private cleanupFns: Array<() => void> = [];
  private senderId: string;
  private senderName: string;
  private lastSent = 0;
  private readonly THROTTLE_MS = 33; // ~30 updates/s

  constructor(el: HTMLElement, send: DCsender, senderId: string, senderName: string) {
    this.el = el;
    this.send = send;
    this.senderId = senderId;
    this.senderName = senderName;
  }

  enable() {
    if (this.active) return;
    this.active = true;

    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - this.lastSent < this.THROTTLE_MS) return;
      this.lastSent = now;

      const rect = this.el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

      const pos: CursorPos = { x, y };
      this.send(makeDCMessage('cursor', { ...pos, senderId: this.senderId, senderName: this.senderName }));
    };

    this.el.addEventListener('mousemove', onMove);
    this.cleanupFns.push(() => this.el.removeEventListener('mousemove', onMove));
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
  }
}
