export interface ConnectionStats {
  rtt: number;           // ms
  packetLoss: number;    // 0–100 %
  jitter: number;        // ms
  fps: number;
  width: number;
  height: number;
  bitrate: number;       // kbps
  transport: 'P2P' | 'TURN' | 'unknown';
  quality: 'excellent' | 'good' | 'fair' | 'poor';
}

const EMPTY: ConnectionStats = {
  rtt: 0, packetLoss: 0, jitter: 0, fps: 0,
  width: 0, height: 0, bitrate: 0,
  transport: 'unknown', quality: 'excellent',
};

type StatsHandler = (s: ConnectionStats) => void;

export class StatsMonitor {
  private pc: RTCPeerConnection;
  private intervalId?: ReturnType<typeof setInterval>;
  private handlers: StatsHandler[] = [];
  private prevBytesSent = 0;
  private prevBytesRecv = 0;
  private prevTs = Date.now();
  readonly current: ConnectionStats = { ...EMPTY };

  constructor(pc: RTCPeerConnection) {
    this.pc = pc;
  }

  start(intervalMs = 2000) {
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop() {
    clearInterval(this.intervalId);
  }

  on(handler: StatsHandler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  private async poll() {
    const report = await this.pc.getStats();
    const stats = { ...EMPTY };
    let bytesSent = 0, bytesRecv = 0;
    let totalPackets = 0, lostPackets = 0;

    report.forEach((s: RTCStats) => {
      const r = s as unknown as Record<string, unknown>;
      switch (s.type) {
        case 'candidate-pair':
          if (r['state'] === 'succeeded' || r['nominated']) {
            stats.rtt = Math.round(((r['currentRoundTripTime'] as number) ?? 0) * 1000);
          }
          break;
        case 'outbound-rtp':
          if (r['kind'] === 'video') {
            bytesSent += (r['bytesSent'] as number) ?? 0;
            stats.fps = Math.round((r['framesPerSecond'] as number) ?? 0);
            stats.width = (r['frameWidth'] as number) ?? 0;
            stats.height = (r['frameHeight'] as number) ?? 0;
          }
          break;
        case 'inbound-rtp':
          if (r['kind'] === 'video') {
            bytesRecv += (r['bytesReceived'] as number) ?? 0;
            stats.fps = Math.round((r['framesPerSecond'] as number) ?? stats.fps);
            stats.width = (r['frameWidth'] as number) ?? stats.width;
            stats.height = (r['frameHeight'] as number) ?? stats.height;
            lostPackets += (r['packetsLost'] as number) ?? 0;
            totalPackets += ((r['packetsReceived'] as number) ?? 0) + lostPackets;
            stats.jitter = Math.round(((r['jitter'] as number) ?? 0) * 1000);
          }
          break;
        case 'remote-inbound-rtp':
          if (r['kind'] === 'video') {
            lostPackets += (r['packetsLost'] as number) ?? 0;
            totalPackets += (r['packetsReceived'] as number) ?? 0;
            if ((r['roundTripTime'] as number) > 0) {
              stats.rtt = Math.round(((r['roundTripTime'] as number)) * 1000);
            }
          }
          break;
        case 'local-candidate':
          if (r['candidateType'] === 'relay') stats.transport = 'TURN';
          else if (stats.transport !== 'TURN') stats.transport = 'P2P';
          break;
      }
    });

    const now = Date.now();
    const dt = (now - this.prevTs) / 1000;
    if (dt > 0) {
      const totalBytes = (bytesSent - this.prevBytesSent) + (bytesRecv - this.prevBytesRecv);
      stats.bitrate = Math.round((totalBytes * 8) / dt / 1000); // kbps
    }
    this.prevBytesSent = bytesSent;
    this.prevBytesRecv = bytesRecv;
    this.prevTs = now;

    if (totalPackets > 0) {
      stats.packetLoss = parseFloat(((lostPackets / totalPackets) * 100).toFixed(1));
    }

    stats.quality =
      stats.rtt < 50 && stats.packetLoss < 1 ? 'excellent'
      : stats.rtt < 150 && stats.packetLoss < 5 ? 'good'
      : stats.rtt < 300 && stats.packetLoss < 15 ? 'fair'
      : 'poor';

    Object.assign(this.current, stats);
    this.handlers.forEach((h) => h({ ...stats }));
  }
}
