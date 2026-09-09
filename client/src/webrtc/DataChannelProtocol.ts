// Central DataChannel message protocol — all peer-to-peer communication flows through here.
// Messages are JSON-encoded. Binary data (file chunks) is base64 inside the JSON payload.

export type DCMessageType =
  | 'input'             // RemoteInputEvent  — viewer → host
  | 'cursor'            // CursorPos         — viewer → host (throttled, control mode)
  | 'laser'             // LaserPos          — viewer → host (always, annotation mode)
  | 'chat'              // ChatMsg           — bidirectional
  | 'file-offer'        // FileOffer         — sender → receiver
  | 'file-accept'       // {fileId}          — receiver → sender
  | 'file-reject'       // {fileId, reason}  — receiver → sender
  | 'file-chunk'        // FileChunk         — sender → receiver
  | 'file-cancel'       // {fileId}          — either direction
  | 'clipboard-push'    // ClipboardData     — either direction (if permitted)
  | 'permission'        // Permissions       — host → viewer
  | 'recording-start'   // {}               — host → viewer (notice)
  | 'recording-stop'    // {}               — host → viewer (notice)
  | 'annotation-draw'   // Stroke           — any → broadcast
  | 'annotation-clear'; // {userId?}        — any → broadcast

export interface DCMessage {
  type: DCMessageType;
  payload: unknown;
  id: string;
  ts: number;
  from?: string; // userId of sender — set by host on relay
}

// ---- Payload shapes ----

export interface ChatMsg {
  text: string;
  senderName: string;
  senderId: string;
}

export interface CursorPos {
  x: number; // 0–1 normalized
  y: number;
}

export interface LaserPos {
  x: number;       // 0–1 normalized; -1 = mouse left element
  y: number;
  senderId: string;
  senderName: string;
}

export interface FileOffer {
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
}

export interface FileChunk {
  fileId: string;
  index: number;
  total: number;
  data: string; // base64
}

export interface ClipboardData {
  text: string;
}

export interface Permissions {
  remoteControl: boolean;
  clipboard: boolean;
  fileTransfer: boolean;
  chat: boolean;
  recording: boolean;
}

export const DEFAULT_PERMISSIONS: Permissions = {
  remoteControl: false,
  clipboard: false,
  fileTransfer: false,
  chat: true,
  recording: false,
};

// ---- Helpers ----

let _seq = 0;
export function makeDCMessage(type: DCMessageType, payload: unknown, from?: string): DCMessage {
  return { type, payload, id: `${Date.now()}-${++_seq}`, ts: Date.now(), from };
}

export function encodeDC(msg: DCMessage): string {
  return JSON.stringify(msg);
}

export function decodeDC(raw: string): DCMessage | null {
  try {
    return JSON.parse(raw) as DCMessage;
  } catch {
    return null;
  }
}

export const CHUNK_SIZE = 16 * 1024;         // 16 KB per chunk
export const BUFFER_THRESHOLD = 256 * 1024;  // pause sending above this
export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB hard limit
export const MAX_CHUNK_SIZE = 64 * 1024;     // reject incoming chunks larger than this
export const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000; // 5 min inactivity timeout

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
