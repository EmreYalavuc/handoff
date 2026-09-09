import type {
  SignalingMessage,
  S2CType,
  C2SType,
  JoinPayload,
} from '../types/signaling';

type MessageHandler = (msg: SignalingMessage) => void;

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

interface SignalingClientOptions {
  url: string;
  onStateChange?: (state: ConnectionState) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<S2CType | '*', Set<MessageHandler>>();
  private url: string;
  private onStateChange?: (state: ConnectionState) => void;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 2000;
  private intentionalClose = false;

  constructor(options: SignalingClientOptions) {
    this.url = options.url;
    this.onStateChange = options.onStateChange;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.intentionalClose = false;
      this.ws = new WebSocket(this.url);
      this.onStateChange?.('connecting');

      this.ws.onopen = () => {
        this.reconnectDelay = 2000;
        this.onStateChange?.('connected');
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as SignalingMessage;
          this.dispatch(msg);
        } catch {
          console.error('[Signaling] Failed to parse message', event.data);
        }
      };

      this.ws.onclose = () => {
        this.onStateChange?.('disconnected');
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.onStateChange?.('error');
        reject(new Error('WebSocket connection failed'));
      };
    });
  }

  disconnect() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(type: C2SType, payload?: unknown, to?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Signaling] Cannot send, not connected');
      return;
    }
    const msg: SignalingMessage = { type, payload, to };
    this.ws.send(JSON.stringify(msg));
  }

  join(payload: JoinPayload) {
    this.send('join', payload);
  }

  on(type: S2CType | '*', handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.off(type, handler);
  }

  off(type: S2CType | '*', handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler);
  }

  private dispatch(msg: SignalingMessage) {
    const type = msg.type as S2CType;
    this.handlers.get(type)?.forEach((h) => h(msg));
    this.handlers.get('*')?.forEach((h) => h(msg));
  }

  private scheduleReconnect() {
    this.reconnectTimer = setTimeout(() => {
      console.log('[Signaling] Attempting reconnect...');
      this.connect().catch(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        if (!this.intentionalClose) this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }
}
