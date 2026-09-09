import {
  makeDCMessage, arrayBufferToBase64, base64ToUint8Array,
  CHUNK_SIZE, BUFFER_THRESHOLD, MAX_FILE_SIZE, MAX_CHUNK_SIZE, TRANSFER_TIMEOUT_MS,
  type DCMessage, type FileOffer, type FileChunk,
} from './DataChannelProtocol';

export interface TransferProgress {
  fileId: string;
  name: string;
  size: number;
  bytesTransferred: number;
  speed: number;       // bytes/s
  state: 'pending' | 'active' | 'done' | 'cancelled' | 'error';
  direction: 'send' | 'receive';
  errorMessage?: string;
}

type ProgressHandler = (p: TransferProgress) => void;
type DCsender = (msg: DCMessage) => void;

/** Manages both sending and receiving file transfers over DataChannel. */
export class FileTransferManager {
  private sends = new Map<string, SendState>();
  private receives = new Map<string, ReceiveState>();
  private handlers: ProgressHandler[] = [];

  /** Offer a file to the peer. Returns the fileId, or null if the file exceeds the size limit. */
  async send(file: File, sendFn: DCsender): Promise<string | null> {
    if (file.size > MAX_FILE_SIZE) {
      console.warn(`[FileTransfer] File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
      return null;
    }

    const fileId = `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

    // Duplicate protection: reject if fileId already exists
    if (this.sends.has(fileId) || this.receives.has(fileId)) {
      console.warn(`[FileTransfer] Duplicate fileId rejected: ${fileId}`);
      return null;
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const offer: FileOffer = {
      fileId, name: file.name, size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks, chunkSize: CHUNK_SIZE,
    };
    sendFn(makeDCMessage('file-offer', offer));

    const state: SendState = {
      fileId, file, totalChunks,
      progress: { fileId, name: file.name, size: file.size, bytesTransferred: 0, speed: 0, state: 'pending', direction: 'send' },
      sendFn,
      cancelled: false,
      lastActivityAt: Date.now(),
    };
    this.sends.set(fileId, state);
    this.emit(state.progress);
    return fileId;
  }

  cancel(fileId: string, sendFn: DCsender) {
    const s = this.sends.get(fileId) ?? this.receives.get(fileId);
    if (!s) return;
    s.cancelled = true;
    sendFn(makeDCMessage('file-cancel', { fileId }));
    s.progress.state = 'cancelled';
    this.emit(s.progress);
    this.sends.delete(fileId);
    this.receives.delete(fileId);
  }

  /** Cancel all active transfers (call on session end). */
  cancelAll() {
    for (const [fileId, state] of this.sends.entries()) {
      state.cancelled = true;
      state.progress.state = 'cancelled';
      this.emit(state.progress);
      this.sends.delete(fileId);
    }
    for (const [fileId, state] of this.receives.entries()) {
      state.cancelled = true;
      state.progress.state = 'cancelled';
      this.emit(state.progress);
      this.receives.delete(fileId);
    }
  }

  /** Call when a dc-message arrives. Returns true if handled. */
  async handleMessage(msg: DCMessage, sendFn: DCsender): Promise<boolean> {
    switch (msg.type) {
      case 'file-offer':  return this.onOffer(msg, sendFn);
      case 'file-accept': return this.onAccept(msg);
      case 'file-reject': return this.onReject(msg);
      case 'file-chunk':  return this.onChunk(msg);
      case 'file-cancel': return this.onCancel(msg);
      default:            return false;
    }
  }

  on(handler: ProgressHandler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  private emit(p: TransferProgress) { this.handlers.forEach((h) => h({ ...p })); }

  private onOffer(msg: DCMessage, sendFn: DCsender): boolean {
    const offer = msg.payload as FileOffer;

    // Validate offer fields
    if (!offer.fileId || typeof offer.fileId !== 'string') return false;
    if (typeof offer.size !== 'number' || offer.size < 0) return false;
    if (typeof offer.totalChunks !== 'number' || offer.totalChunks < 1) return false;

    // Reject oversized files
    if (offer.size > MAX_FILE_SIZE) {
      console.warn(`[FileTransfer] Rejecting oversized file offer: ${offer.size} bytes`);
      sendFn(makeDCMessage('file-reject', { fileId: offer.fileId, reason: 'File too large' }));
      return true;
    }

    // Duplicate protection: reject if fileId already tracked
    if (this.receives.has(offer.fileId) || this.sends.has(offer.fileId)) {
      sendFn(makeDCMessage('file-reject', { fileId: offer.fileId, reason: 'Duplicate transfer ID' }));
      return true;
    }

    const state: ReceiveState = {
      fileId: offer.fileId, name: offer.name, size: offer.size,
      mimeType: offer.mimeType, totalChunks: offer.totalChunks,
      chunks: new Array(offer.totalChunks),
      received: 0,
      startTs: Date.now(),
      lastActivityAt: Date.now(),
      progress: {
        fileId: offer.fileId, name: offer.name, size: offer.size,
        bytesTransferred: 0, speed: 0, state: 'pending', direction: 'receive',
      },
      cancelled: false,
    };
    this.receives.set(offer.fileId, state);

    // Auto-accept; room.ts may have intercepted with a prompt before this runs
    sendFn(makeDCMessage('file-accept', { fileId: offer.fileId }));
    state.progress.state = 'active';
    this.emit(state.progress);

    // Inactivity timeout
    this.startTimeout(offer.fileId, 'receive', sendFn);
    return true;
  }

  private onAccept(msg: DCMessage): boolean {
    const { fileId } = msg.payload as { fileId: string };
    const state = this.sends.get(fileId);
    if (!state) return false;
    state.progress.state = 'active';
    state.lastActivityAt = Date.now();
    this.emit(state.progress);
    this.runSend(state);
    return true;
  }

  private onReject(msg: DCMessage): boolean {
    const { fileId } = msg.payload as { fileId: string };
    const state = this.sends.get(fileId);
    if (!state) return false;
    state.cancelled = true;
    state.progress.state = 'cancelled';
    this.emit(state.progress);
    this.sends.delete(fileId);
    return true;
  }

  private onChunk(msg: DCMessage): boolean {
    const chunk = msg.payload as FileChunk;
    if (!chunk.fileId || typeof chunk.index !== 'number') return false;

    const state = this.receives.get(chunk.fileId);
    if (!state || state.cancelled) return false;

    // Chunk index bounds validation
    if (chunk.index < 0 || chunk.index >= state.totalChunks) {
      console.warn(`[FileTransfer] Invalid chunk index ${chunk.index} for ${chunk.fileId}`);
      return false;
    }

    // Chunk size validation
    const data = base64ToUint8Array(chunk.data);
    if (data.length > MAX_CHUNK_SIZE) {
      console.warn(`[FileTransfer] Oversized chunk rejected: ${data.length} bytes`);
      return false;
    }

    // Reject duplicate chunks (replay protection)
    if (state.chunks[chunk.index] !== undefined) return false;

    state.chunks[chunk.index] = data;
    state.received++;
    state.lastActivityAt = Date.now();

    const bytesTransferred = Math.min(state.received * CHUNK_SIZE, state.size);
    const elapsed = (Date.now() - state.startTs) / 1000;
    state.progress.bytesTransferred = bytesTransferred;
    state.progress.speed = elapsed > 0 ? bytesTransferred / elapsed : 0;
    this.emit(state.progress);

    if (state.received === state.totalChunks) {
      state.progress.state = 'done';
      this.emit(state.progress);
      this.triggerDownload(state);
      this.receives.delete(chunk.fileId);
    }
    return true;
  }

  private onCancel(msg: DCMessage): boolean {
    const { fileId } = msg.payload as { fileId: string };
    const s = this.sends.get(fileId) ?? this.receives.get(fileId);
    if (!s) return false;
    s.cancelled = true;
    s.progress.state = 'cancelled';
    this.emit(s.progress);
    this.sends.delete(fileId);
    this.receives.delete(fileId);
    return true;
  }

  private async runSend(state: SendState) {
    const { file, fileId, totalChunks, sendFn } = state;
    const startTs = Date.now();

    for (let i = 0; i < totalChunks; i++) {
      if (state.cancelled) return;

      await waitForDrain(state.sendFn);

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const slice = await file.slice(start, end).arrayBuffer();

      const chunk: FileChunk = {
        fileId, index: i, total: totalChunks, data: arrayBufferToBase64(slice),
      };
      sendFn(makeDCMessage('file-chunk', chunk));
      state.lastActivityAt = Date.now();

      const bytesTransferred = end;
      const elapsed = (Date.now() - startTs) / 1000;
      state.progress.bytesTransferred = bytesTransferred;
      state.progress.speed = elapsed > 0 ? bytesTransferred / elapsed : 0;
      this.emit(state.progress);
    }

    if (!state.cancelled) {
      state.progress.state = 'done';
      this.emit(state.progress);
      this.sends.delete(fileId);
    }
  }

  private startTimeout(fileId: string, direction: 'send' | 'receive', sendFn: DCsender) {
    const checkId = setInterval(() => {
      const state = direction === 'receive'
        ? this.receives.get(fileId)
        : this.sends.get(fileId);

      if (!state) { clearInterval(checkId); return; }
      if (state.cancelled || state.progress.state === 'done') { clearInterval(checkId); return; }

      if (Date.now() - state.lastActivityAt > TRANSFER_TIMEOUT_MS) {
        clearInterval(checkId);
        state.cancelled = true;
        state.progress.state = 'error';
        state.progress.errorMessage = 'Transfer timed out';
        this.emit(state.progress);
        sendFn(makeDCMessage('file-cancel', { fileId }));
        this.sends.delete(fileId);
        this.receives.delete(fileId);
        console.warn(`[FileTransfer] Transfer ${fileId} timed out`);
      }
    }, 30_000);
  }

  private triggerDownload(state: ReceiveState) {
    const merged = new Uint8Array(state.size);
    let offset = 0;
    for (const chunk of state.chunks) {
      if (chunk) { merged.set(chunk, offset); offset += chunk.length; }
    }
    const blob = new Blob([merged], { type: state.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

async function waitForDrain(_sendFn: DCsender) {
  await new Promise((r) => setTimeout(r, 0));
}

interface SendState {
  fileId: string;
  file: File;
  totalChunks: number;
  progress: TransferProgress;
  sendFn: DCsender;
  cancelled: boolean;
  lastActivityAt: number;
}

interface ReceiveState {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunks: (Uint8Array | undefined)[];
  received: number;
  startTs: number;
  lastActivityAt: number;
  progress: TransferProgress;
  cancelled: boolean;
}
