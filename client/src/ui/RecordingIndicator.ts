/** 🔴 REC indicator with live timer shown in the topbar. */
export class RecordingIndicator {
  private el: HTMLElement;
  private timerEl: HTMLElement;
  private startTs = 0;
  private tickId?: ReturnType<typeof setInterval>;

  constructor(containerId: string) {
    const parent = document.getElementById(containerId);
    if (!parent) throw new Error(`#${containerId} not found`);

    this.el = document.createElement('div');
    this.el.className = 'rec-indicator';
    this.el.innerHTML = `<span class="rec-dot"></span><span class="rec-label">REC</span><span class="rec-timer">00:00</span>`;
    this.timerEl = this.el.querySelector('.rec-timer')!;
    parent.appendChild(this.el);
  }

  start() {
    this.startTs = Date.now();
    this.el.classList.add('rec-indicator--active');
    this.tickId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTs) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      this.timerEl.textContent = `${m}:${s}`;
    }, 1000);
  }

  stop() {
    clearInterval(this.tickId);
    this.el.classList.remove('rec-indicator--active');
    this.timerEl.textContent = '00:00';
  }
}
