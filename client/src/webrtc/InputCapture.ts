import type { RemoteInputEvent, InputEventType } from '../types/signaling';

type InputSender = (event: RemoteInputEvent) => void;

/**
 * Captures mouse and keyboard events from a video element
 * and converts them to normalized RemoteInputEvents for the DataChannel.
 *
 * Mouse coordinates are normalized (0–1) relative to the video element
 * so the HOST can map them to actual screen coordinates regardless of
 * the viewer's window size.
 */
export class InputCapture {
  private el: HTMLElement;
  private send: InputSender;
  private active = false;
  private cleanupFns: Array<() => void> = [];

  constructor(element: HTMLElement, sender: InputSender) {
    this.el = element;
    this.send = sender;
  }

  enable() {
    if (this.active) return;
    this.active = true;

    this.el.style.cursor = 'crosshair';

    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions
    ) => {
      this.el.addEventListener(type, handler as EventListener, opts);
      this.cleanupFns.push(() => this.el.removeEventListener(type, handler as EventListener));
    };

    on('mousemove', (e) => {
      this.send({ type: 'mousemove', ...this.mouseCoords(e) });
    });

    on('mousedown', (e) => {
      e.preventDefault();
      this.send({ type: 'mousedown', ...this.mouseCoords(e), button: e.button });
    });

    on('mouseup', (e) => {
      this.send({ type: 'mouseup', ...this.mouseCoords(e), button: e.button });
    });

    on('wheel', (e) => {
      e.preventDefault();
      this.send({
        type: 'wheel',
        ...this.mouseCoords(e),
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    }, { passive: false });

    // Keyboard events need to be on window, but we only send when element is focused/active
    const keydown = (e: KeyboardEvent) => {
      if (!this.active) return;
      e.preventDefault();
      this.send({ type: 'keydown', key: e.key, code: e.code, modifiers: this.mods(e) });
    };
    const keyup = (e: KeyboardEvent) => {
      if (!this.active) return;
      e.preventDefault();
      this.send({ type: 'keyup', key: e.key, code: e.code, modifiers: this.mods(e) });
    };

    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    this.cleanupFns.push(
      () => window.removeEventListener('keydown', keydown),
      () => window.removeEventListener('keyup', keyup)
    );
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.el.style.cursor = '';
    this.cleanupFns.forEach((fn) => fn());
    this.cleanupFns = [];
  }

  private mouseCoords(e: MouseEvent): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }

  private mods(e: KeyboardEvent) {
    return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
  }
}
