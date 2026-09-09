import type { SignalingClient } from '../signaling/SignalingClient';
import { decodeDC, encodeDC, makeDCMessage, DEFAULT_PERMISSIONS, type DCMessage, type Permissions } from './DataChannelProtocol';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export type ViewerEvent =
  | { type: 'state-change'; state: 'idle' | 'connecting' | 'connected' | 'failed' }
  | { type: 'stream'; stream: MediaStream }
  | { type: 'control-granted' }
  | { type: 'control-denied' }
  | { type: 'control-revoked' }
  | { type: 'dc-message'; message: DCMessage };

type Handler = (e: ViewerEvent) => void;

export class ViewerConnection {
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private hostId: string | null = null;
  private signaling: SignalingClient;
  private handlers: Handler[] = [];
  private offHandlers: Array<() => void> = [];

  permissions: Permissions = { ...DEFAULT_PERMISSIONS };
  hasControl = false;

  get peerConnection(): RTCPeerConnection | null { return this.pc; }

  constructor(signaling: SignalingClient) {
    this.signaling = signaling;
    this.registerSignalingHandlers();
  }

  sendDC(msg: DCMessage) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;
    this.dataChannel.send(encodeDC(msg));
  }

  requestControl() {
    if (!this.hostId) return;
    this.signaling.send('control-request', {}, this.hostId);
  }

  close() {
    this.pc?.close();
    this.pc = null;
    this.dataChannel = null;
    this.hasControl = false;
    this.offHandlers.forEach((fn) => fn());
    this.offHandlers = [];
    this.emit({ type: 'state-change', state: 'idle' });
  }

  on(handler: Handler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  private emit(e: ViewerEvent) { this.handlers.forEach((h) => h(e)); }

  private async handleOffer(fromId: string, sdp: RTCSessionDescriptionInit) {
    this.hostId = fromId;
    this.emit({ type: 'state-change', state: 'connecting' });

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.hostId) {
        this.signaling.send('ice-candidate', { candidate: candidate.toJSON() }, this.hostId);
      }
    };

    this.pc.ontrack = ({ streams }) => {
      if (streams[0]) this.emit({ type: 'stream', stream: streams[0] });
    };

    this.pc.ondatachannel = ({ channel }) => {
      this.dataChannel = channel;
      channel.onmessage = ({ data }) => {
        const msg = decodeDC(data);
        if (!msg) return;

        // Handle permission updates internally
        if (msg.type === 'permission') {
          Object.assign(this.permissions, msg.payload as Permissions);
        }

        this.emit({ type: 'dc-message', message: msg });
      };
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'connected') this.emit({ type: 'state-change', state: 'connected' });
      else if (s === 'failed' || s === 'closed') this.emit({ type: 'state-change', state: 'failed' });
    };

    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send('answer', { sdp: this.pc.localDescription }, fromId);
  }

  private registerSignalingHandlers() {
    const off1 = this.signaling.on('offer', (msg) => {
      if (!msg.from) return;
      const { sdp } = msg.payload as { sdp: RTCSessionDescriptionInit };
      this.handleOffer(msg.from, sdp);
    });

    const off2 = this.signaling.on('ice-candidate', (msg) => {
      if (!msg.from || msg.from !== this.hostId || !this.pc) return;
      const { candidate } = msg.payload as { candidate: RTCIceCandidateInit };
      this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    });

    const off3 = this.signaling.on('control-response', (msg) => {
      const { granted } = msg.payload as { granted: boolean };
      if (granted) {
        this.hasControl = true;
        this.emit({ type: 'control-granted' });
      } else {
        this.hasControl = false;
        this.emit({ type: 'control-denied' });
      }
    });

    const off4 = this.signaling.on('control-revoked', () => {
      this.hasControl = false;
      this.emit({ type: 'control-revoked' });
    });

    this.offHandlers.push(off1, off2, off3, off4);
  }
}
