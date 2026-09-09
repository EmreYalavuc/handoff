import type { StatsMonitor, ConnectionStats } from './StatsMonitor';

export type QualityPreset = 'auto' | 'high' | 'balanced' | 'low';

interface QualityConfig {
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
  maxBitrate: number; // kbps
}

const PRESETS: Record<Exclude<QualityPreset, 'auto'>, QualityConfig> = {
  high:     { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60, maxBitrate: 8000 },
  balanced: { maxWidth: 1280, maxHeight: 720,  maxFrameRate: 30, maxBitrate: 3000 },
  low:      { maxWidth: 854,  maxHeight: 480,  maxFrameRate: 20, maxBitrate: 1000 },
};

export class QualityController {
  private senders: RTCRtpSender[] = [];
  private preset: QualityPreset = 'auto';
  private monitor: StatsMonitor;
  private cooldownUntil = 0; // don't change quality too rapidly

  constructor(monitor: StatsMonitor) {
    this.monitor = monitor;
    monitor.on((stats) => this.onStats(stats));
  }

  setSenders(senders: RTCRtpSender[]) {
    this.senders = senders.filter((s) => s.track?.kind === 'video');
  }

  setPreset(p: QualityPreset) {
    this.preset = p;
    if (p !== 'auto') this.applyConfig(PRESETS[p]);
  }

  private onStats(stats: ConnectionStats) {
    if (this.preset !== 'auto') return;
    if (Date.now() < this.cooldownUntil) return;

    let target: Exclude<QualityPreset, 'auto'>;
    if (stats.quality === 'excellent') target = 'high';
    else if (stats.quality === 'good') target = 'balanced';
    else target = 'low';

    this.applyConfig(PRESETS[target]);
    this.cooldownUntil = Date.now() + 10_000; // 10-second cooldown
  }

  private applyConfig(cfg: QualityConfig) {
    for (const sender of this.senders) {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = cfg.maxBitrate * 1000;
      params.encodings[0].maxFramerate = cfg.maxFrameRate;
      params.encodings[0].scaleResolutionDownBy = Math.max(
        1,
        Math.ceil(Math.max(1920 / cfg.maxWidth, 1080 / cfg.maxHeight))
      );
      sender.setParameters(params).catch(() => {});
    }
  }
}
