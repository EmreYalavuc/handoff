/**
 * Shows a temporary notification banner at the top of the room.
 * Used for control requests, permission grants, etc.
 */
export class NotificationToast {
  private container: HTMLElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  }

  show(opts: {
    message: string;
    type?: 'info' | 'success' | 'warning' | 'danger';
    duration?: number;
    actions?: Array<{ label: string; variant: 'primary' | 'danger' | 'secondary'; onClick: () => void }>;
  }) {
    const toast = document.createElement('div');
    toast.className = `toast toast--${opts.type ?? 'info'}`;

    const msg = document.createElement('span');
    msg.className = 'toast-message';
    msg.textContent = opts.message;
    toast.appendChild(msg);

    if (opts.actions) {
      const actions = document.createElement('div');
      actions.className = 'toast-actions';
      opts.actions.forEach(({ label, variant, onClick }) => {
        const btn = document.createElement('button');
        btn.className = `btn btn--sm btn--${variant}`;
        btn.textContent = label;
        btn.addEventListener('click', () => {
          onClick();
          this.remove(toast);
        });
        actions.appendChild(btn);
      });
      toast.appendChild(actions);
    }

    this.container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add('toast--visible'));

    if (opts.duration !== 0) {
      const dur = opts.duration ?? (opts.actions ? 30000 : 4000);
      setTimeout(() => this.remove(toast), dur);
    }

    return () => this.remove(toast);
  }

  private remove(toast: HTMLElement) {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }
}
