import type { ConnectionStats } from '../webrtc/StatsMonitor';
import type { QualityPreset } from '../webrtc/QualityController';

type PresetHandler = (p: QualityPreset) => void;

const QUALITY_COLOR: Record<ConnectionStats['quality'], string> = {
  excellent: 'var(--success)',
  good: 'var(--success)',
  fair: 'var(--warning)',
  poor: 'var(--danger)',
};

/** Compact stats strip shown in the topbar. Click → expand diagnostics panel. */
export class StatsStrip {
  private container: HTMLElement;
  private expanded = false;
  private detailEl: HTMLElement;
  private onPreset?: PresetHandler;
  private currentPreset: QualityPreset = 'auto';

  constructor(containerId: string, onPreset?: PresetHandler) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`#${containerId} not found`);
    this.container = el;
    this.onPreset = onPreset;
    this.build();
    this.detailEl = document.getElementById('stats-detail-panel')!;
  }

  update(stats: ConnectionStats) {
    const strip = this.container.querySelector<HTMLElement>('.stats-strip');
    if (!strip) return;
    strip.innerHTML = `
      <span class="stats-dot" style="background:${QUALITY_COLOR[stats.quality]}"></span>
      <span>${stats.rtt}ms</span>
      <span>${stats.fps}fps</span>
      ${stats.bitrate > 0 ? `<span>${(stats.bitrate / 1000).toFixed(1)}M</span>` : ''}
      <span class="stats-transport">${stats.transport}</span>
    `;

    // Update detail panel
    const d = this.detailEl;
    if (!d) return;
    d.querySelector<HTMLElement>('[data-key="quality"]')!.textContent = stats.quality;
    d.querySelector<HTMLElement>('[data-key="quality"]')!.style.color = QUALITY_COLOR[stats.quality];
    d.querySelector<HTMLElement>('[data-key="rtt"]')!.textContent = `${stats.rtt} ms`;
    d.querySelector<HTMLElement>('[data-key="loss"]')!.textContent = `${stats.packetLoss}%`;
    d.querySelector<HTMLElement>('[data-key="jitter"]')!.textContent = `${stats.jitter} ms`;
    d.querySelector<HTMLElement>('[data-key="fps"]')!.textContent = `${stats.fps}`;
    d.querySelector<HTMLElement>('[data-key="res"]')!.textContent =
      stats.width > 0 ? `${stats.width}×${stats.height}` : '—';
    d.querySelector<HTMLElement>('[data-key="bitrate"]')!.textContent =
      `${(stats.bitrate / 1000).toFixed(1)} Mbps`;
    d.querySelector<HTMLElement>('[data-key="transport"]')!.textContent = stats.transport;
  }

  private build() {
    this.container.innerHTML = `<div class="stats-strip" title="Click for details"></div>`;
    this.container.addEventListener('click', () => this.toggleDetail());

    // Detail panel (appended to body)
    const panel = document.createElement('div');
    panel.id = 'stats-detail-panel';
    panel.className = 'stats-detail-panel';
    panel.innerHTML = `
      <div class="stats-detail-header">
        <span>Connection</span>
        <strong data-key="quality" class="stats-quality-label">—</strong>
        <button class="btn btn--ghost btn--sm stats-detail-close">✕</button>
      </div>
      <table class="stats-table">
        <tr><td>Latency</td><td><strong data-key="rtt">—</strong></td></tr>
        <tr><td>Packet Loss</td><td><strong data-key="loss">—</strong></td></tr>
        <tr><td>Jitter</td><td><strong data-key="jitter">—</strong></td></tr>
        <tr><td>FPS</td><td><strong data-key="fps">—</strong></td></tr>
        <tr><td>Resolution</td><td><strong data-key="res">—</strong></td></tr>
        <tr><td>Bitrate</td><td><strong data-key="bitrate">—</strong></td></tr>
        <tr><td>Transport</td><td><strong data-key="transport">—</strong></td></tr>
      </table>
      <div class="stats-quality-presets">
        <span class="stats-preset-label">Quality</span>
        ${(['auto','high','balanced','low'] as QualityPreset[]).map((p) =>
          `<button class="btn btn--ghost btn--sm preset-btn${p === this.currentPreset ? ' btn--active' : ''}" data-preset="${p}">${p}</button>`
        ).join('')}
      </div>
    `;
    panel.querySelector('.stats-detail-close')!.addEventListener('click', () => this.toggleDetail(false));
    panel.querySelectorAll<HTMLButtonElement>('.preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('btn--active'));
        btn.classList.add('btn--active');
        this.currentPreset = btn.dataset.preset as QualityPreset;
        this.onPreset?.(this.currentPreset);
      });
    });
    document.body.appendChild(panel);
  }

  private toggleDetail(force?: boolean) {
    this.expanded = force !== undefined ? force : !this.expanded;
    const panel = document.getElementById('stats-detail-panel')!;
    panel.classList.toggle('stats-detail-panel--open', this.expanded);
  }
}
