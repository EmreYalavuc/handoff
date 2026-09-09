import type { TransferProgress } from '../webrtc/FileTransfer';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

export class FileTransferPanel {
  private container: HTMLElement;
  private cards = new Map<string, HTMLElement>();
  private onCancel?: (fileId: string) => void;

  constructor(containerId: string, onCancel?: (fileId: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    this.onCancel = onCancel;
    this.container.className = 'file-transfer-panel';
  }

  update(progress: TransferProgress) {
    let card = this.cards.get(progress.fileId);
    if (!card) {
      card = this.createCard(progress);
      this.container.appendChild(card);
      this.cards.set(progress.fileId, card);
    }
    this.updateCard(card, progress);

    if (progress.state === 'done' || progress.state === 'cancelled' || progress.state === 'error') {
      setTimeout(() => {
        card!.classList.add('ft-card--fading');
        setTimeout(() => { card!.remove(); this.cards.delete(progress.fileId); }, 400);
      }, progress.state === 'done' ? 3000 : 1500);
    }
  }

  private createCard(p: TransferProgress): HTMLElement {
    const card = document.createElement('div');
    card.className = 'ft-card';
    card.innerHTML = `
      <div class="ft-card-header">
        <span class="ft-icon">${p.direction === 'send' ? '↑' : '↓'}</span>
        <span class="ft-name" title="${p.name}">${p.name}</span>
        <button class="ft-cancel btn btn--sm btn--ghost" title="Cancel">✕</button>
      </div>
      <div class="ft-progress-bar"><div class="ft-progress-fill" style="width:0%"></div></div>
      <div class="ft-meta">
        <span class="ft-bytes">0 / ${fmtSize(p.size)}</span>
        <span class="ft-speed"></span>
        <span class="ft-pct">0%</span>
      </div>
    `;
    card.querySelector('.ft-cancel')!.addEventListener('click', () => {
      this.onCancel?.(p.fileId);
    });
    return card;
  }

  private updateCard(card: HTMLElement, p: TransferProgress) {
    const pct = p.size > 0 ? Math.round((p.bytesTransferred / p.size) * 100) : 0;
    (card.querySelector('.ft-progress-fill') as HTMLElement).style.width = `${pct}%`;
    (card.querySelector('.ft-bytes') as HTMLElement).textContent =
      `${fmtSize(p.bytesTransferred)} / ${fmtSize(p.size)}`;
    (card.querySelector('.ft-speed') as HTMLElement).textContent =
      p.speed > 0 ? fmtSpeed(p.speed) : '';
    (card.querySelector('.ft-pct') as HTMLElement).textContent = `${pct}%`;

    if (p.state === 'done') {
      card.classList.add('ft-card--done');
      (card.querySelector('.ft-pct') as HTMLElement).textContent = '✓ Done';
    } else if (p.state === 'cancelled') {
      card.classList.add('ft-card--cancelled');
      (card.querySelector('.ft-pct') as HTMLElement).textContent = 'Cancelled';
    }
  }
}
