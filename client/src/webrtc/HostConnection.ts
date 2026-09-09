import type { SignalingClient } from '../signaling/SignalingClient';
import {
  decodeDC, encodeDC, makeDCMessage,
  DEFAULT_PERMISSIONS, BUFFER_THRESHOLD,
  type DCMessage, type DCMessageType, type Permissions,
} from './DataChannelProtocol';
import type { RemoteInputEvent } from '../types/signaling';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface ViewerSession {
  peerId: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  controlGranted: boolean;
  permissions: Permissions;
}

export type HostEvent =
  | { type: 'viewer-connected'; peerId: string }
  | { type: 'viewer-disconnected'; peerId: string }
  | { type: 'dc-message'; peerId: string; message: DCMessage }
  | { type: 'swap-stream'; peerId: string; stream: MediaStream }
  | { type: 'swap-ended'; peerId: string };

type Handler = (e: HostEvent) => void;

/**
 * Manages all WebRTC sessions on the HOST side.
 * All DataChannel messages are surfaced as 'dc-message' events for feature managers to consume.
 */
export class HostConnectionManager {
  private sessions = new Map<string, ViewerSession>();
  private swapSessions = new Map<string, RTCPeerConnection>();
  private stream: MediaStream | null = null;
  private signaling: SignalingClient;
  private myId: string;
  private handlers: Handler[] = [];

  constructor(signaling: SignalingClient, myId: string) {
    this.signaling = signaling;
    this.myId = myId;
    this.registerSignalingHandlers();
  }

  setStream(stream: MediaStream) {
    this.stream = stream;
    for (const s of this.sessions.values()) {
      stream.getTracks().forEach((track) => {
        s.pc.getSenders().forEach((sender) => {
          if (sender.track?.kind === track.kind) sender.replaceTrack(track);
        });
      });
    }
  }

  async initiateOffer(viewerId: string) {
    if (this.sessions.has(viewerId)) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dataChannel = pc.createDataChannel('main', { ordered: true });
    dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;

    const session: ViewerSession = {
      peerId: viewerId,
      pc,
      dataChannel,
      controlGranted: false,
      permissions: { ...DEFAULT_PERMISSIONS },
    };
    this.sessions.set(viewerId, session);

    this.setupPC(session);
    this.setupDC(session);

    if (this.stream) {
      this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream!));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.send('offer', { sdp: pc.localDescription }, viewerId);
  }

  // ---- DC sending ----

  sendDC(viewerId: string, msg: DCMessage) {
    const session = this.sessions.get(viewerId);
    if (!session?.dataChannel || session.dataChannel.readyState !== 'open') return;
    session.dataChannel.send(encodeDC(msg));
  }

  broadcastDC(msg: DCMessage, excludeViewerId?: string) {
    for (const session of this.sessions.values()) {
      if (session.peerId === excludeViewerId) continue;
      this.sendDC(session.peerId, msg);
    }
  }

  // ---- Control ----

  grantControl(viewerId: string) {
    const s = this.sessions.get(viewerId);
    if (!s) return;
    s.controlGranted = true;
    s.permissions.remoteControl = true;
    this.signaling.send('control-response', { granted: true }, viewerId);
    this.pushPermissions(viewerId);
  }

  denyControl(viewerId: string) {
    const s = this.sessions.get(viewerId);
    if (!s) return;
    this.signaling.send('control-response', { granted: false }, viewerId);
  }

  revokeControl(viewerId: string) {
    const s = this.sessions.get(viewerId);
    if (!s) return;
    s.controlGranted = false;
    s.permissions.remoteControl = false;
    this.signaling.send('control-revoke', {}, viewerId);
    this.pushPermissions(viewerId);
  }

  updatePermissions(viewerId: string, patch: Partial<Permissions>) {
    const s = this.sessions.get(viewerId);
    if (!s) return;
    Object.assign(s.permissions, patch);
    this.pushPermissions(viewerId);
  }

  getPermissions(viewerId: string): Permissions | undefined {
    return this.sessions.get(viewerId)?.permissions;
  }

  private pushPermissions(viewerId: string) {
    const s = this.sessions.get(viewerId);
    if (!s) return;
    this.sendDC(viewerId, makeDCMessage('permission', s.permissions, this.myId));
  }

  // ---- Session lifecycle ----

  closeSession(viewerId: string) {
    const s = this.sessions.get(viewerId);
    if (s) { s.pc.close(); this.sessions.delete(viewerId); }
    this.closeSwapSession(viewerId);
  }

  closeAll() {
    for (const s of this.sessions.values()) s.pc.close();
    this.sessions.clear();
    for (const pc of this.swapSessions.values()) pc.close();
    this.swapSessions.clear();
  }

  getSenderFor(viewerId: string): RTCRtpSender[] {
    return this.sessions.get(viewerId)?.pc.getSenders() ?? [];
  }

  getPeerConnection(viewerId: string): RTCPeerConnection | undefined {
    return this.sessions.get(viewerId)?.pc;
  }

  // ---- Events ----

  on(handler: Handler) {
    this.handlers.push(handler);
    return () => { this.handlers = this.handlers.filter((h) => h !== handler); };
  }

  private emit(e: HostEvent) { this.handlers.forEach((h) => h(e)); }

  // ---- PC + DC setup ----

  private setupPC(session: ViewerSession) {
    const { pc, peerId } = session;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signaling.send('ice-candidate', { candidate: candidate.toJSON() }, peerId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.emit({ type: 'viewer-connected', peerId });
        // push initial permissions
        this.pushPermissions(peerId);
      } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.emit({ type: 'viewer-disconnected', peerId });
        this.sessions.delete(peerId);
      }
    };
  }

  private setupDC(session: ViewerSession) {
    const { dataChannel, peerId } = session;
    if (!dataChannel) return;

    dataChannel.onmessage = ({ data }) => {
      const msg = decodeDC(data);
      if (!msg) return;

      // Gate input events by permission
      if (msg.type === 'input' && !session.controlGranted) return;

      this.emit({ type: 'dc-message', peerId, message: msg });
    };
  }

  // ---- Swap mode ----

  private async handleSwapOffer(viewerId: string, sdp: RTCSessionDescriptionInit) {
    this.swapSessions.get(viewerId)?.close();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.swapSessions.set(viewerId, pc);

    pc.ontrack = ({ streams }) => {
      if (streams[0]) this.emit({ type: 'swap-stream', peerId: viewerId, stream: streams[0] });
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signaling.send('swap-ice', { candidate: candidate.toJSON(), origin: 'host' }, viewerId);
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this.swapSessions.delete(viewerId);
        this.emit({ type: 'swap-ended', peerId: viewerId });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.send('swap-answer', { sdp: pc.localDescription }, viewerId);
  }

  private async handleSwapIce(viewerId: string, candidate: RTCIceCandidateInit) {
    try {
      await this.swapSessions.get(viewerId)?.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }

  private closeSwapSession(viewerId: string) {
    const pc = this.swapSessions.get(viewerId);
    if (!pc) return;
    pc.close();
    this.swapSessions.delete(viewerId);
    this.emit({ type: 'swap-ended', peerId: viewerId });
  }

  // ---- Signaling ----

  private registerSignalingHandlers() {
    this.signaling.on('answer', (msg) => {
      if (!msg.from) return;
      const s = this.sessions.get(msg.from);
      if (!s) return;
      const { sdp } = msg.payload as { sdp: RTCSessionDescriptionInit };
      s.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    });

    this.signaling.on('ice-candidate', (msg) => {
      if (!msg.from) return;
      const s = this.sessions.get(msg.from);
      if (!s) return;
      const { candidate } = msg.payload as { candidate: RTCIceCandidateInit };
      s.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    });

    this.signaling.on('swap-offer', (msg) => {
      if (!msg.from) return;
      const { sdp } = msg.payload as { sdp: RTCSessionDescriptionInit };
      this.handleSwapOffer(msg.from, sdp);
    });

    this.signaling.on('swap-ice', (msg) => {
      if (!msg.from) return;
      const { candidate, origin } = msg.payload as { candidate: RTCIceCandidateInit; origin?: string };
      if (origin === 'viewer') this.handleSwapIce(msg.from, candidate);
    });

    this.signaling.on('swap-stop', (msg) => {
      if (msg.from) this.closeSwapSession(msg.from);
    });
  }
}
