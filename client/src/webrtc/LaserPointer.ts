import { makeDCMessage, type DCMessage } from './DataChannelProtocol';

type DCsender = (msg: DCMessage) => void;

/** VIEWER-side: continuously streams mouse position as a laser pointer to the host. */
export class LaserPointer {
  private active = false;
  private cleanup: (() => void)[] = [];
  private lastSent = 0;
  private readonly THROTTLE_MS = 33; // ~30 fps

  constructor(
    private el: HTMLElement,
    private send: DCsender,
    private senderId: string,
    private senderName: string,
  ) {}

  enable() {
    if (this.active) return;
    this.active = true;

    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - this.lastSent < this.THROTTLE_MS) return;
      this.lastSent = now;
      const rect = this.el.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top)   / rect.height));
      this.send(makeDCMessage('laser', { x, y, senderId: this.senderId, senderName: this.senderName }));
    };

    const onLeave = () => {
      this.send(makeDCMessage('laser', { x: -1, y: -1, senderId: this.senderId, senderName: this.senderName }));
    };

    this.el.addEventListener('mousemove', onMove);
    this.el.addEventListener('mouseleave', onLeave);
    this.cleanup.push(
      () => this.el.removeEventListener('mousemove', onMove),
      () => this.el.removeEventListener('mouseleave', onLeave),
    );
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.cleanup.forEach(fn => fn());
    this.cleanup = [];
  }
}
