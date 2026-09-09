import { SpeedLimiter } from './SpeedLimiter';

/** 256 KB — safe for all major browsers over DataChannel SCTP */
export const CHUNK_SIZE = 256 * 1024;

/** 4-byte header (chunkIndex uint32 BE) prepended to each binary message */
const HEADER_BYTES = 4;

/** Pause sending above this DataChannel buffer level */
const HIGH_WATERMARK = 8 * 1024 * 1024; // 8 MB
/** Resume sending when buffer drops below this level */
const LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB

export interface SendProgress {
  transferId: string;
  sentChunks: number;
  totalChunks: number;
  sentBytes: number;
  totalBytes: number;
  speedBps: number; // current bytes/sec
}

type ProgressCb = (p: SendProgress) => void;

/** High-performance chunked file sender over a binary RTCDataChannel. */
export class ChunkSender {
  private paused = false;
  private cancelled = false;
  private resumeResolve?: () => void;
  private drainResolve?: () => void;

  constructor(
    private readonly dc: RTCDataChannel,
    private readonly limiter: SpeedLimiter,
    private readonly onProgress: ProgressCb,
  ) {
    this.dc.bufferedAmountLowThreshold = LOW_WATERMARK;
    this.dc.onbufferedamountlow = () => {
      if (this.drainResolve) { this.drainResolve(); this.drainResolve = undefined; }
    };
  }

  pause()  { this.paused = true; }
  cancel() { this.cancelled = true; this.resumed(); } // wake up any waiting loops

  resume(fromChunk?: number) {
    this.paused = false;
    if (this.resumeResolve) { this.resumeResolve(); this.resumeResolve = undefined; }
    return fromChunk;
  }

  private resumed() {
    if (this.resumeResolve) { this.resumeResolve(); this.resumeResolve = undefined; }
  }

  async send(file: File, transferId: string, startChunk = 0): Promise<'done' | 'cancelled'> {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const header = new ArrayBuffer(HEADER_BYTES);
    const headerView = new DataView(header);

    // Speed measurement
    let speedBps = 0;
    let windowBytes = 0;
    let windowStart = performance.now();
    const SPEED_WINDOW_MS = 1000;

    let progressTs = 0;
    const PROGRESS_INTERVAL_MS = 400;

    for (let i = startChunk; i < totalChunks; i++) {
      if (this.cancelled) return 'cancelled';

      // Pause support
      if (this.paused) {
        await new Promise<void>(r => { this.resumeResolve = r; });
        if (this.cancelled) return 'cancelled';
      }

      // Backpressure
      if (this.dc.bufferedAmount > HIGH_WATERMARK) {
        await new Promise<void>(r => { this.drainResolve = r; });
      }

      // Speed limit
      await this.limiter.consume(CHUNK_SIZE);

      // Read one chunk from disk (only CHUNK_SIZE bytes in memory at a time)
      const offset = i * CHUNK_SIZE;
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      const chunkData = await file.slice(offset, end).arrayBuffer();

      // Prepend 4-byte chunk index
      headerView.setUint32(0, i, false /* big-endian */);
      const msg = concat(header, chunkData);
      this.dc.send(msg);

      // Speed tracking
      const chunkBytes = end - offset;
      windowBytes += chunkBytes;
      const now = performance.now();
      const elapsed = now - windowStart;
      if (elapsed >= SPEED_WINDOW_MS) {
        speedBps = (windowBytes / elapsed) * 1000;
        windowBytes = 0;
        windowStart = now;
      }

      // Throttled progress reporting (every 400ms)
      if (now - progressTs > PROGRESS_INTERVAL_MS) {
        progressTs = now;
        this.onProgress({
          transferId,
          sentChunks: i + 1,
          totalChunks,
          sentBytes: end,
          totalBytes: file.size,
          speedBps,
        });
      }
    }

    // Final progress
    this.onProgress({
      transferId,
      sentChunks: totalChunks,
      totalChunks,
      sentBytes: file.size,
      totalBytes: file.size,
      speedBps,
    });

    return 'done';
  }
}

function concat(a: ArrayBuffer, b: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out.buffer;
}
