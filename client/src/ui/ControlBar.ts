import type { FitMode } from './VideoViewer';

interface ControlBarOptions {
  role: 'host' | 'viewer';
  onFit: (mode: FitMode) => void;
  onFullscreen: () => void;
  onRequestControl?: () => void;
  onShareScreen?: () => void;
  onStopShare?: () => void;
  onSwapToggle?: () => void;
}

export class ControlBar {
  private container: HTMLElement;
  private opts: ControlBarOptions;
  private controlBtn: HTMLButtonElement | null = null;
  private shareBtn: HTMLButtonElement | null = null;
  private swapBtn: HTMLButtonElement | null = null;
  private activeFit: FitMode = 'contain';

  constructor(containerId: string, opts: ControlBarOptions) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    this.opts = opts;
    this.render();
  }

  setControlState(state: 'none' | 'requested' | 'granted') {
    if (!this.controlBtn) return;
    const btn = this.controlBtn;
    if (state === 'none') {
      btn.textContent = 'Request Control';
      btn.className = 'btn btn--secondary';
      btn.disabled = false;
    } else if (state === 'requested') {
      btn.textContent = 'Requesting...';
      btn.className = 'btn btn--secondary';
      btn.disabled = true;
    } else {
      btn.textContent = 'Release Control';
      btn.className = 'btn btn--danger';
      btn.disabled = false;
    }
  }

  setShareState(sharing: boolean) {
    if (!this.shareBtn) return;
    if (sharing) {
      this.shareBtn.textContent = 'Stop Sharing';
      this.shareBtn.className = 'btn btn--danger';
    } else {
      this.shareBtn.textContent = 'Share Screen';
      this.shareBtn.className = 'btn btn--primary';
    }
  }

  setSwapState(active: boolean) {
    if (!this.swapBtn) return;
    if (active) {
      this.swapBtn.innerHTML = `${swapIcon()} Stop Swap`;
      this.swapBtn.className = 'btn btn--danger';
    } else {
      this.swapBtn.innerHTML = `${swapIcon()} Swap Screen`;
      this.swapBtn.className = 'btn btn--secondary';
    }
  }

  private render() {
    this.container.innerHTML = '';

    const left = document.createElement('div');
    left.className = 'controlbar-left';

    // Fit mode button group
    const fitGroup = document.createElement('div');
    fitGroup.className = 'btn-group';

    const fitModes: { label: string; mode: FitMode }[] = [
      { label: 'Fit', mode: 'contain' },
      { label: 'Fill', mode: 'cover' },
      { label: 'Actual', mode: 'actual' },
    ];

    fitModes.forEach(({ label, mode }) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn--ghost' + (mode === this.activeFit ? ' btn--active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.activeFit = mode;
        fitGroup.querySelectorAll('button').forEach((b) => b.classList.remove('btn--active'));
        btn.classList.add('btn--active');
        this.opts.onFit(mode);
      });
      fitGroup.appendChild(btn);
    });

    left.appendChild(fitGroup);

    const fsBtn = document.createElement('button');
    fsBtn.className = 'btn btn--ghost';
    fsBtn.innerHTML = `${fullscreenIcon()} Fullscreen`;
    fsBtn.addEventListener('click', () => this.opts.onFullscreen());
    left.appendChild(fsBtn);

    this.container.appendChild(left);

    const right = document.createElement('div');
    right.className = 'controlbar-right';

    // HOST: share screen toggle
    if (this.opts.role === 'host' && this.opts.onShareScreen) {
      const btn = document.createElement('button');
      btn.className = 'btn btn--primary';
      btn.textContent = 'Share Screen';
      btn.addEventListener('click', () => {
        if (btn.textContent === 'Stop Sharing') {
          this.opts.onStopShare?.();
        } else {
          this.opts.onShareScreen?.();
        }
      });
      this.shareBtn = btn;
      right.appendChild(btn);
    }

    // VIEWER: swap mode toggle
    if (this.opts.role === 'viewer' && this.opts.onSwapToggle) {
      const btn = document.createElement('button');
      btn.className = 'btn btn--secondary';
      btn.innerHTML = `${swapIcon()} Swap Screen`;
      btn.title = 'Share your screen back to the host (bidirectional mode)';
      btn.addEventListener('click', () => this.opts.onSwapToggle?.());
      this.swapBtn = btn;
      right.appendChild(btn);
    }

    // VIEWER: request control
    if (this.opts.role === 'viewer' && this.opts.onRequestControl) {
      const btn = document.createElement('button');
      btn.className = 'btn btn--secondary';
      btn.textContent = 'Request Control';
      btn.addEventListener('click', () => {
        if (btn.textContent === 'Release Control') {
          this.setControlState('none');
        } else {
          this.opts.onRequestControl?.();
          this.setControlState('requested');
        }
      });
      this.controlBtn = btn;
      right.appendChild(btn);
    }

    this.container.appendChild(right);
  }
}

function fullscreenIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
}

function swapIcon() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4"/><path d="M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>`;
}
