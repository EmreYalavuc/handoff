export type FitMode = 'contain' | 'cover' | 'actual';

export class VideoViewer {
  private container: HTMLElement;
  private video: HTMLVideoElement;
  private fitMode: FitMode = 'contain';
  private pipEl: HTMLElement | null = null;
  private pipVideo: HTMLVideoElement | null = null;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.className = 'remote-video';
    this.applyFit();

    this.container.appendChild(this.video);
  }

  getVideoElement(): HTMLVideoElement { return this.video; }
  getContainer(): HTMLElement { return this.container; }

  setStream(stream: MediaStream) {
    this.video.srcObject = stream;
  }

  clearStream() {
    this.video.srcObject = null;
  }

  setFit(mode: FitMode) {
    this.fitMode = mode;
    this.applyFit();
  }

  async enterFullscreen() {
    try {
      await this.container.requestFullscreen();
    } catch {
      await this.video.requestFullscreen().catch(() => {});
    }
  }

  exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  showPlaceholder(message: string = 'Waiting for host screen share...') {
    this.video.style.display = 'none';
    let ph = this.container.querySelector<HTMLElement>('.video-placeholder');
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'video-placeholder';
      this.container.appendChild(ph);
    }
    ph.textContent = message;
    ph.style.display = 'flex';
  }

  hidePlaceholder() {
    const ph = this.container.querySelector<HTMLElement>('.video-placeholder');
    if (ph) ph.style.display = 'none';
    this.video.style.display = 'block';
  }

  // --- PIP overlay for swap mode ---

  setSecondaryStream(stream: MediaStream, label = "Viewer's screen") {
    if (!this.pipEl) this.buildPip();
    this.pipVideo!.srcObject = stream;
    const lbl = this.pipEl!.querySelector<HTMLElement>('.pip-label');
    if (lbl) lbl.textContent = label;
    this.pipEl!.classList.add('pip--visible');
  }

  clearSecondaryStream() {
    if (!this.pipEl) return;
    this.pipEl.classList.remove('pip--visible');
    if (this.pipVideo) this.pipVideo.srcObject = null;
  }

  private buildPip() {
    this.pipEl = document.createElement('div');
    this.pipEl.className = 'pip-container';

    this.pipVideo = document.createElement('video');
    this.pipVideo.autoplay = true;
    this.pipVideo.playsInline = true;
    this.pipVideo.muted = true;
    this.pipVideo.className = 'pip-video';

    const label = document.createElement('div');
    label.className = 'pip-label';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pip-close';
    closeBtn.title = 'Close swap view';
    closeBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearSecondaryStream();
    });

    this.pipEl.appendChild(this.pipVideo);
    this.pipEl.appendChild(label);
    this.pipEl.appendChild(closeBtn);
    this.makeDraggable(this.pipEl);
    this.container.appendChild(this.pipEl);
  }

  private makeDraggable(el: HTMLElement) {
    let active = false;
    let startX = 0, startY = 0;
    let origRight = 16, origBottom = 16;

    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.pip-close')) return;
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      const cr = this.container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      origRight = cr.right - er.right;
      origBottom = cr.bottom - er.bottom;
      el.style.transition = 'none';
      e.preventDefault();
    });

    const onMove = (e: MouseEvent) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const cr = this.container.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const newRight = Math.max(0, Math.min(cr.width - er.width, origRight - dx));
      const newBottom = Math.max(0, Math.min(cr.height - er.height, origBottom - dy));
      el.style.right = `${newRight}px`;
      el.style.bottom = `${newBottom}px`;
    };

    const onUp = () => {
      active = false;
      el.style.transition = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  private applyFit() {
    if (this.fitMode === 'actual') {
      this.video.style.objectFit = 'none';
      this.video.style.width = 'auto';
      this.video.style.height = 'auto';
      this.container.style.overflow = 'auto';
    } else {
      this.video.style.objectFit = this.fitMode;
      this.video.style.width = '100%';
      this.video.style.height = '100%';
      this.container.style.overflow = 'hidden';
    }
  }
}
