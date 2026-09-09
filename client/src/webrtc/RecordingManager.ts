export interface RecordingMeta {
  sessionId: string;
  startTime: number;
  duration: number;    // ms, updated live
  participants: string[];
}

type RecordingHandler = (state: 'started' | 'stopped', meta: RecordingMeta) => void;

export class RecordingManager {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private meta: RecordingMeta | null = null;
  private tickId?: ReturnType<typeof setInterval>;
  private handlers: RecordingHandler[] = [];

  get isRecording() { return !!this.recorder && this.recorder.state === 'recording'; }
  get currentMeta() { return this.meta; }

  start(stream: MediaStream, participants: string[], sessionId: string) {
    if (this.isRecording) return;

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';

    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType });
    this.meta = { sessionId, startTime: Date.now(), duration: 0, participants };

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    this.recorder.onstop = () => this.finalize();
    this.recorder.start(1000); // collect every second

    this.tickId = setInterval(() => {
      if (this.meta) this.meta.duration = Date.now() - this.meta.startTime;
    }, 1000);

    this.handlers.forEach((h) => h('started', { ...this.meta! }));
  }

  stop() {
    if (!this.isRecording || !this.recorder) return;
    clearInterval(this.tickId);
    this.recorder.stop();
  }

  on(handler: RecordingHandler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  private finalize() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const ts = new Date(this.meta?.startTime ?? Date.now())
      .toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${ts}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const meta = { ...this.meta! };
    this.meta = null;
    this.recorder = null;
    this.handlers.forEach((h) => h('stopped', meta));
  }
}
