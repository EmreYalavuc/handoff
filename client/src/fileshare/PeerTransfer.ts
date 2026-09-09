/**
 * PeerTransfer — WebRTC peer connection dedicated to file transfers.
 *
 * Each pair of users in the room has one RTCPeerConnection.
 * - "ctrl" DataChannel: JSON control messages (reliable, ordered)
 * - "t-{transferId}" DataChannel: raw binary chunks (reliable, ordered)
 *
 * The connection is created on-demand when a download is requested.
 */
import { SpeedLimiter } from './SpeedLimiter';
import { ChunkSender, CHUNK_SIZE } from './ChunkSender';

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const HEADER_BYTES = 4; // chunkIndex (uint32 BE)

export type CtrlMsg =
  | { type: 'transfer-start'; transferId: string; fileId: string; fileName: string; size: number; totalChunks: number; chunkSize: number; startChunk?: number }
  | { type: 'transfer-ready'; transferId: string; resumeFrom: number }
  | { type: 'transfer-reject'; transferId: string; reason: string }
  | { type: 'transfer-complete'; transferId: string }
  | { type: 'transfer-cancel'; transferId: string }
  | { type: 'pause-req'; transferId: string }
  | { type: 'pause-ack'; transferId: string; lastChunk: number }
  | { type: 'resume-req'; transferId: string; fromChunk: number }
  | { type: 'resume-ack'; transferId: string };

export interface TransferState {
  transferId: string;
  fileId: string;
  fileName: string;
  size: number;
  totalChunks: number;
  direction: 'send' | 'receive';
  state: 'starting' | 'active' | 'paused' | 'done' | 'cancelled' | 'error';
  sentChunks: number;
  receivedChunks: number;
  speedBps: number;
  startedAt: number;
  // receive-side
  chunks?: (Uint8Array | undefined)[];
  writable?: FileSystemWritableFileStream | null;
}

type TransferEvent =
  | { type: 'transfer-update'; state: TransferState }
  | { type: 'transfer-done'; transferId: string; fileName: string }
  | { type: 'download-request'; transferId: string; fileId: string; fileName: string; size: number }
  | { type: 'closed' };

type EventHandler = (e: TransferEvent) => void;

export class PeerTransfer {
  private pc: RTCPeerConnection;
  private ctrl!: RTCDataChannel;
  private transfers = new Map<string, TransferState>();
  private senders = new Map<string, ChunkSender>();
  private handlers: EventHandler[] = [];

  // Files available to serve (set by owner)
  private localFiles = new Map<string, File>();

  uploadLimiter = new SpeedLimiter(null);

  constructor(
    readonly peerId: string,
    private readonly sendSignal: (type: string, payload: unknown, to: string) => void,
  ) {
    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.wirePC();
  }

  on(h: EventHandler) { this.handlers.push(h); return () => { this.handlers = this.handlers.filter(x => x !== h); }; }
  private emit(e: TransferEvent) { this.handlers.forEach(h => h(e)); }

  registerLocalFile(fileId: string, file: File) {
    this.localFiles.set(fileId, file);
  }

  // ---- Connection initiation (we are the offerer) ----
  async createOffer() {
    this.ctrl = this.pc.createDataChannel('ctrl', { ordered: true });
    this.wireCtrl(this.ctrl);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal('fs-offer', { sdp: this.pc.localDescription }, this.peerId);
  }

  async handleOffer(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal('fs-answer', { sdp: this.pc.localDescription }, this.peerId);
  }

  async handleAnswer(sdp: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(sdp);
  }

  async handleIce(candidate: RTCIceCandidateInit) {
    try { await this.pc.addIceCandidate(candidate); } catch { /* ignore */ }
  }

  // ---- Request a file download from this peer ----
  async requestDownload(transferId: string, fileId: string, fileName: string, size: number) {
    const totalChunks = Math.ceil(size / CHUNK_SIZE);
    let resumeFrom = 0;

    // Check for a partially received transfer in sessionStorage
    const savedKey = `ft-${transferId}`;
    const savedChunk = sessionStorage.getItem(savedKey);
    if (savedChunk) resumeFrom = parseInt(savedChunk, 10);

    const state: TransferState = {
      transferId, fileId, fileName, size, totalChunks,
      direction: 'receive',
      state: 'starting',
      sentChunks: 0,
      receivedChunks: resumeFrom,
      speedBps: 0,
      startedAt: performance.now(),
    };

    // Try to open a streaming write to disk (FSAA)
    state.writable = await tryOpenWritable(fileName);
    if (!state.writable) {
      // Fallback: collect chunks in RAM
      state.chunks = new Array(totalChunks).fill(undefined);
      if (resumeFrom > 0) resumeFrom = 0; // can't resume without persistent storage
    }

    this.transfers.set(transferId, state);
    this.emit({ type: 'transfer-update', state: { ...state } });

    // Open the binary receive DataChannel
    const dc = this.pc.createDataChannel(`t-${transferId}`, { ordered: true });
    this.wireReceiveDc(dc, state);

    // Send request to peer via ctrl channel
    this.sendCtrl({
      type: 'transfer-start',
      transferId, fileId, fileName, size, totalChunks,
      chunkSize: CHUNK_SIZE, startChunk: resumeFrom,
    });
  }

  // ---- Pause / Resume / Cancel ----
  pauseTransfer(transferId: string) {
    const state = this.transfers.get(transferId);
    if (!state) return;
    if (state.direction === 'send') {
      this.senders.get(transferId)?.pause();
      state.state = 'paused';
    } else {
      this.sendCtrl({ type: 'pause-req', transferId });
      state.state = 'paused';
    }
    this.emit({ type: 'transfer-update', state: { ...state } });
  }

  resumeTransfer(transferId: string) {
    const state = this.transfers.get(transferId);
    if (!state || state.state !== 'paused') return;
    if (state.direction === 'send') {
      this.senders.get(transferId)?.resume();
      state.state = 'active';
    } else {
      this.sendCtrl({ type: 'resume-req', transferId, fromChunk: state.receivedChunks });
      state.state = 'active';
    }
    this.emit({ type: 'transfer-update', state: { ...state } });
  }

  cancelTransfer(transferId: string) {
    const state = this.transfers.get(transferId);
    if (!state) return;
    this.senders.get(transferId)?.cancel();
    this.sendCtrl({ type: 'transfer-cancel', transferId });
    state.state = 'cancelled';
    state.writable?.abort?.();
    this.emit({ type: 'transfer-update', state: { ...state } });
    this.transfers.delete(transferId);
    this.senders.delete(transferId);
    sessionStorage.removeItem(`ft-${transferId}`);
  }

  getTransfer(id: string) { return this.transfers.get(id); }
  getAllTransfers() { return Array.from(this.transfers.values()); }

  close() {
    for (const sender of this.senders.values()) sender.cancel();
    this.pc.close();
    this.emit({ type: 'closed' });
  }

  // ---- Private wiring ----
  private wirePC() {
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendSignal('fs-ice', { candidate: e.candidate }, this.peerId);
      }
    };

    // Receiving side: incoming DataChannels from the remote peer (for sending)
    this.pc.ondatachannel = (e) => {
      const dc = e.channel;
      if (dc.label === 'ctrl') {
        this.ctrl = dc;
        this.wireCtrl(dc);
      } else if (dc.label.startsWith('t-')) {
        // Binary send channel opened by the remote (they are sending, we are not)
        // This is for when we receive a channel opened by the remote to send us data
        // Actually: the downloader opens t-{transferId}, the sender receives it here
        this.wireSendDc(dc);
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
        this.emit({ type: 'closed' });
      }
    };
  }

  private wireCtrl(dc: RTCDataChannel) {
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as CtrlMsg;
        this.handleCtrl(msg);
      } catch { /* ignore malformed */ }
    };
  }

  private handleCtrl(msg: CtrlMsg) {
    switch (msg.type) {
      case 'transfer-start': {
        // Remote wants to download a file from us
        const file = this.localFiles.get(msg.fileId);
        if (!file) {
          this.sendCtrl({ type: 'transfer-reject', transferId: msg.transferId, reason: 'File not found' });
          return;
        }
        // Acknowledge
        this.sendCtrl({ type: 'transfer-ready', transferId: msg.transferId, resumeFrom: msg.startChunk ?? 0 });
        // State
        const state: TransferState = {
          transferId: msg.transferId, fileId: msg.fileId, fileName: msg.fileName,
          size: msg.size, totalChunks: msg.totalChunks,
          direction: 'send', state: 'active',
          sentChunks: msg.startChunk ?? 0, receivedChunks: 0,
          speedBps: 0, startedAt: performance.now(),
        };
        this.transfers.set(msg.transferId, state);
        this.emit({ type: 'transfer-update', state: { ...state } });

        // Tell the UI about the incoming download request
        this.emit({ type: 'download-request', transferId: msg.transferId, fileId: msg.fileId, fileName: msg.fileName, size: msg.size });

        // Start sending on the binary DC when it opens (the receiver will open it)
        // We'll find it by label in wireSendDc when the peer opens the channel
        // Store file for wireSendDc to find
        this.localFiles.set(msg.transferId, file); // also keyed by transferId for lookup
        break;
      }

      case 'transfer-ready': {
        // Remote confirmed ready to receive — we (sender) can start
        // The state was set in requestDownload; the receive DC is already open
        // Nothing to do here — chunks are sent when our DC opens (see wireSendDc counterpart)
        break;
      }

      case 'transfer-reject': {
        const state = this.transfers.get(msg.transferId);
        if (state) { state.state = 'error'; this.emit({ type: 'transfer-update', state: { ...state } }); }
        break;
      }

      case 'transfer-cancel': {
        const state = this.transfers.get(msg.transferId);
        if (state) {
          this.senders.get(msg.transferId)?.cancel();
          state.state = 'cancelled';
          state.writable?.abort?.();
          this.emit({ type: 'transfer-update', state: { ...state } });
          this.transfers.delete(msg.transferId);
          this.senders.delete(msg.transferId);
        }
        break;
      }

      case 'pause-req': {
        const sender = this.senders.get(msg.transferId);
        if (sender) {
          const state = this.transfers.get(msg.transferId);
          sender.pause();
          if (state) {
            this.sendCtrl({ type: 'pause-ack', transferId: msg.transferId, lastChunk: state.sentChunks });
            state.state = 'paused';
            this.emit({ type: 'transfer-update', state: { ...state } });
          }
        }
        break;
      }

      case 'resume-req': {
        const sender = this.senders.get(msg.transferId);
        if (sender) {
          sender.resume(msg.fromChunk);
          this.sendCtrl({ type: 'resume-ack', transferId: msg.transferId });
          const state = this.transfers.get(msg.transferId);
          if (state) { state.state = 'active'; this.emit({ type: 'transfer-update', state: { ...state } }); }
        }
        break;
      }

      case 'transfer-complete': {
        const state = this.transfers.get(msg.transferId);
        if (state && state.direction === 'send') {
          state.state = 'done';
          this.emit({ type: 'transfer-update', state: { ...state } });
          this.transfers.delete(msg.transferId);
          this.senders.delete(msg.transferId);
        }
        break;
      }

      case 'pause-ack':
      case 'resume-ack':
        break; // handled by state already
    }
  }

  /** Called when a DataChannel labeled "t-{transferId}" opens (initiated by us or remote) */
  private wireSendDc(dc: RTCDataChannel) {
    // The label is "t-{transferId}"; we are the SENDER on this channel
    const transferId = dc.label.slice(2); // remove "t-"
    const file = this.localFiles.get(transferId);
    if (!file) return;

    const state = this.transfers.get(transferId);
    const startChunk = state?.sentChunks ?? 0;

    dc.binaryType = 'arraybuffer';

    dc.onopen = async () => {
      if (!state) return;
      const sender = new ChunkSender(dc, this.uploadLimiter, (p) => {
        state.sentChunks = p.sentChunks;
        state.speedBps = p.speedBps;
        this.emit({ type: 'transfer-update', state: { ...state } });
      });
      this.senders.set(transferId, sender);

      const result = await sender.send(file, transferId, startChunk);
      if (result === 'done') {
        state.state = 'done';
        this.sendCtrl({ type: 'transfer-complete', transferId });
        this.emit({ type: 'transfer-update', state: { ...state } });
        this.transfers.delete(transferId);
        this.senders.delete(transferId);
        this.localFiles.delete(transferId); // remove transferId alias
      }
    };
  }

  /** Called when we receive the binary DataChannel that we opened for downloading */
  private wireReceiveDc(dc: RTCDataChannel, state: TransferState) {
    dc.binaryType = 'arraybuffer';

    // Rolling speed measurement
    let windowBytes = 0;
    let windowStart = performance.now();
    let progressTs = 0;

    dc.onmessage = async (e) => {
      if (state.state === 'cancelled') return;

      const data = e.data as ArrayBuffer;
      const view = new DataView(data);
      const chunkIndex = view.getUint32(0, false /* big-endian */);
      const chunkData = data.slice(HEADER_BYTES);

      // Speed measurement
      windowBytes += chunkData.byteLength;
      const now = performance.now();
      if (now - windowStart >= 1000) {
        state.speedBps = (windowBytes / (now - windowStart)) * 1000;
        windowBytes = 0;
        windowStart = now;
      }

      // Write chunk
      if (state.writable) {
        // FSAA: stream directly to disk (zero RAM footprint)
        try { await state.writable.write(chunkData); } catch { state.writable = null; /* fallback below */ }
      }
      if (!state.writable) {
        // Fallback: collect in memory
        if (!state.chunks) state.chunks = new Array(state.totalChunks).fill(undefined);
        if (state.chunks[chunkIndex] === undefined) {
          state.chunks[chunkIndex] = new Uint8Array(chunkData);
        }
      }

      state.receivedChunks = Math.max(state.receivedChunks, chunkIndex + 1);
      // Persist progress for potential resume
      sessionStorage.setItem(`ft-${state.transferId}`, String(state.receivedChunks));

      // Throttled UI update
      if (now - progressTs > 400) {
        progressTs = now;
        this.emit({ type: 'transfer-update', state: { ...state } });
      }

      // Check completion
      if (state.receivedChunks >= state.totalChunks) {
        state.state = 'done';
        if (state.writable) {
          await state.writable.close();
          state.writable = null;
        } else if (state.chunks) {
          triggerDownload(state.fileName, state.chunks);
        }
        this.sendCtrl({ type: 'transfer-complete', transferId: state.transferId });
        this.emit({ type: 'transfer-done', transferId: state.transferId, fileName: state.fileName });
        this.emit({ type: 'transfer-update', state: { ...state } });
        this.transfers.delete(state.transferId);
        sessionStorage.removeItem(`ft-${state.transferId}`);
      }
    };
  }

  private sendCtrl(msg: CtrlMsg) {
    if (this.ctrl?.readyState === 'open') {
      this.ctrl.send(JSON.stringify(msg));
    }
  }
}

// ---- Helpers ----

async function tryOpenWritable(fileName: string): Promise<FileSystemWritableFileStream | null> {
  if (!('showSaveFilePicker' in window)) return null;
  try {
    const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker({ suggestedName: fileName });
    return handle.createWritable();
  } catch {
    return null; // user cancelled or not supported
  }
}

function triggerDownload(fileName: string, chunks: (Uint8Array | undefined)[]) {
  const parts: ArrayBuffer[] = [];
  for (const c of chunks) { if (c) parts.push(c.buffer as ArrayBuffer); }
  const blob = new Blob(parts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
