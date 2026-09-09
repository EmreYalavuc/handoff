/** HOST-side: renders a glowing red laser dot for each viewer's mouse position. */
export class LaserPointerOverlay {
  private container: HTMLElement;
  private dots = new Map<string, HTMLElement>();
  private hideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
  }

  /** x/y normalized 0–1. Pass x=-1 to hide (mouse left). */
  update(viewerId: string, viewerName: string, x: number, y: number) {
    if (x < 0 || y < 0) { this.hide(viewerId); return; }

    let dot = this.dots.get(viewerId);
    if (!dot) {
      dot = this.buildDot(viewerName);
      this.dots.set(viewerId, dot);
      this.container.appendChild(dot);
    }

    const px = x * this.container.clientWidth;
    const py = y * this.container.clientHeight;
    dot.style.transform = `translate(${px}px, ${py}px)`;
    dot.style.opacity = '1';

    clearTimeout(this.hideTimers.get(viewerId));
    this.hideTimers.set(viewerId, setTimeout(() => this.hide(viewerId), 3000));
  }

  hide(viewerId: string) {
    const dot = this.dots.get(viewerId);
    if (dot) dot.style.opacity = '0';
  }

  remove(viewerId: string) {
    clearTimeout(this.hideTimers.get(viewerId));
    this.hideTimers.delete(viewerId);
    this.dots.get(viewerId)?.remove();
    this.dots.delete(viewerId);
  }

  destroy() {
    for (const id of this.dots.keys()) this.remove(id);
  }

  private buildDot(name: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'laser-dot';
    el.title = `${name}'s laser`;
    return el;
  }
}
