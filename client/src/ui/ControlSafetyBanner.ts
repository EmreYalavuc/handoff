/** Prominent banner shown on the HOST when a viewer has active control. */
export class ControlSafetyBanner {
  private banner: HTMLElement;
  private onStop: () => void;

  constructor(onStop: () => void) {
    this.onStop = onStop;
    this.banner = document.createElement('div');
    this.banner.className = 'control-safety-banner';
    this.banner.innerHTML = `
      <div class="csb-inner">
        <span class="csb-dot"></span>
        <span class="csb-text">Remote Control Active — <strong class="csb-controller-name"></strong></span>
        <button class="btn btn--danger btn--sm csb-stop">⬛ Stop Control</button>
      </div>
    `;
    this.banner.querySelector('.csb-stop')!.addEventListener('click', () => this.onStop());
    document.getElementById('video-container')?.parentElement?.insertBefore(
      this.banner,
      document.getElementById('video-container')
    );
  }

  show(controllerName: string) {
    const nameEl = this.banner.querySelector<HTMLElement>('.csb-controller-name');
    if (nameEl) nameEl.textContent = `Controlled by ${controllerName}`;
    this.banner.classList.add('csb--active');
  }

  hide() {
    this.banner.classList.remove('csb--active');
  }
}
