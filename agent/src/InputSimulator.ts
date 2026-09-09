// eslint-disable-next-line @typescript-eslint/no-require-imports
const robot = require('@jitsi/robotjs') as typeof import('@jitsi/robotjs');

export interface ScreenSize { width: number; height: number; }

// Map browser KeyboardEvent.key → robotjs key name
const KEY_MAP: Record<string, string> = {
  Enter: 'enter', Escape: 'escape', Backspace: 'backspace', Tab: 'tab',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  F1:'f1', F2:'f2', F3:'f3', F4:'f4', F5:'f5', F6:'f6',
  F7:'f7', F8:'f8', F9:'f9', F10:'f10', F11:'f11', F12:'f12',
  ' ': 'space', CapsLock: 'caps_lock',
  Control: 'control', Alt: 'alt', Shift: 'shift', Meta: 'command',
  PrintScreen: 'printscreen', ScrollLock: 'scrolllock', Pause: 'pause',
  NumLock: 'numlock',
};

export class InputSimulator {
  private screenSize: ScreenSize;

  constructor() {
    const size = robot.getScreenSize();
    this.screenSize = { width: size.width, height: size.height };
    robot.setMouseDelay(0);
    robot.setKeyboardDelay(0);
  }

  getScreenSize(): ScreenSize { return { ...this.screenSize }; }

  mouseMove(normalizedX: number, normalizedY: number) {
    const x = Math.round(normalizedX * this.screenSize.width);
    const y = Math.round(normalizedY * this.screenSize.height);
    robot.moveMouse(x, y);
  }

  mouseDown(normalizedX: number, normalizedY: number, button: number) {
    this.mouseMove(normalizedX, normalizedY);
    robot.mouseToggle('down', this.mapButton(button));
  }

  mouseUp(normalizedX: number, normalizedY: number, button: number) {
    this.mouseMove(normalizedX, normalizedY);
    robot.mouseToggle('up', this.mapButton(button));
  }

  scroll(normalizedX: number, normalizedY: number, deltaX: number, deltaY: number) {
    this.mouseMove(normalizedX, normalizedY);
    // robotjs scroll: positive = down
    robot.scrollMouse(Math.round(deltaX / 3), Math.round(deltaY / 3));
  }

  keyDown(key: string, modifiers: string[]) {
    const k = this.mapKey(key);
    if (!k) return;
    const mods = this.mapModifiers(modifiers);
    if (mods.length > 0) {
      robot.keyToggle(k, 'down', mods);
    } else {
      robot.keyToggle(k, 'down');
    }
  }

  keyUp(key: string, modifiers: string[]) {
    const k = this.mapKey(key);
    if (!k) return;
    const mods = this.mapModifiers(modifiers);
    if (mods.length > 0) {
      robot.keyToggle(k, 'up', mods);
    } else {
      robot.keyToggle(k, 'up');
    }
  }

  private mapButton(btn: number): 'left' | 'right' | 'middle' {
    if (btn === 2) return 'right';
    if (btn === 1) return 'middle';
    return 'left';
  }

  private mapKey(key: string): string | null {
    if (KEY_MAP[key]) return KEY_MAP[key];
    // Single printable character
    if (key.length === 1) return key.toLowerCase();
    return null;
  }

  private mapModifiers(mods: string[]): string[] {
    const result: string[] = [];
    if (mods.includes('ctrl')) result.push('control');
    if (mods.includes('alt')) result.push('alt');
    if (mods.includes('shift')) result.push('shift');
    if (mods.includes('meta')) result.push('command');
    return result;
  }
}
