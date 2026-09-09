import type { SignalingClient } from '../signaling/SignalingClient';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Manages the VIEWER-side reverse PeerConnection for swap mode.
 *
 * Normal flow:  HOST --[screen]--> VIEWER
 * Swap mode:    HOST --[screen]--> VIEWER  (unchanged)
 *               VIEWER --[screen]--> HOST  (this class handles this direction)
 *
 * VIEWER acts as offerer for the swap connection.
 * HOST receives the incoming stream and displays it as a PIP overlay.
 */
export class SwapSession {
  private pc: RTCPeerConnection | null = null;
  private signaling: SignalingClient;
  private hostId: string;
  private offHandlers: Array<() => void> = [];

  constructor(signaling: SignalingClient, hostId: string) {
    this.signaling = signaling;
    this.hostId = hostId;
    this.registerHandlers();
  }

  async start(stream: MediaStream): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    stream.getTracks().forEach((t) => this.pc!.addTrack(t, stream));

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.send('swap-ice', { candidate: candidate.toJSON(), origin: 'viewer' }, this.hostId);
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === 'failed' || s === 'closed') {
        this.cleanup();
      }
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send('swap-offer', { sdp: this.pc.localDescription }, this.hostId);
  }

  stop(): void {
    this.signaling.send('swap-stop', {}, this.hostId);
    this.cleanup();
  }

  private cleanup(): void {
    this.pc?.close();
    this.pc = null;
    this.offHandlers.forEach((fn) => fn());
    this.offHandlers = [];
  }

  private registerHandlers(): void {
    const offAnswer = this.signaling.on('swap-answer', (msg) => {
      if (msg.from !== this.hostId || !this.pc) return;
      const payload = msg.payload as { sdp: RTCSessionDescriptionInit };
      this.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)).catch(console.error);
    });

    const offIce = this.signaling.on('swap-ice', (msg) => {
      if (msg.from !== this.hostId || !this.pc) return;
      const payload = msg.payload as { candidate: RTCIceCandidateInit; origin?: string };
      // Only apply ICE candidates that came from host (origin: 'host')
      if (payload.origin === 'host') {
        this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(console.warn);
      }
    });

    this.offHandlers.push(offAnswer, offIce);
  }
}
