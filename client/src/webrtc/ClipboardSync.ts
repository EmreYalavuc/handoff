import { makeDCMessage, type DCMessage, type ClipboardData } from './DataChannelProtocol';

type DCsender = (msg: DCMessage) => void;
type ClipboardHandler = (text: string, from: string) => void;

/**
 * Clipboard sync — requires explicit user action (browser security).
 * Caller must ensure permissions.clipboard === true before enabling.
 */
export class ClipboardSync {
  private handlers: ClipboardHandler[] = [];

  /** Push local clipboard to peer. */
  async push(sendFn: DCsender, fromId: string): Promise<boolean> {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return false;
      const payload: ClipboardData = { text };
      sendFn(makeDCMessage('clipboard-push', payload, fromId));
      return true;
    } catch {
      return false; // no permission or user denied
    }
  }

  /** Handle an incoming clipboard-push dc-message. */
  async receive(msg: DCMessage): Promise<boolean> {
    if (msg.type !== 'clipboard-push') return false;
    const { text } = msg.payload as ClipboardData;
    const fromId = msg.from ?? 'peer';
    try {
      await navigator.clipboard.writeText(text);
      this.handlers.forEach((h) => h(text, fromId));
      return true;
    } catch {
      return false;
    }
  }

  on(handler: ClipboardHandler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }
}
