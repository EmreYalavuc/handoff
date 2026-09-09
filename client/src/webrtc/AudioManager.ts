export interface AudioConfig {
  systemAudio: boolean;
  microphone: boolean;
}

/**
 * Manages audio tracks for the HOST side.
 * System audio comes from getDisplayMedia; microphone from getUserMedia.
 * Both are added as separate tracks to every viewer peer connection.
 */
export class AudioManager {
  private systemStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private addTrackFn: (track: MediaStreamTrack, stream: MediaStream) => void;

  constructor(addTrackFn: (track: MediaStreamTrack, stream: MediaStream) => void) {
    this.addTrackFn = addTrackFn;
  }

  async enableSystemAudio(screenStream: MediaStream): Promise<boolean> {
    const audioTracks = screenStream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.warn('[Audio] No system audio track in screen stream.');
      return false;
    }
    this.systemStream = new MediaStream(audioTracks);
    audioTracks.forEach((t) => this.addTrackFn(t, this.systemStream!));
    return true;
  }

  async enableMicrophone(): Promise<boolean> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.micStream.getAudioTracks().forEach((t) => this.addTrackFn(t, this.micStream!));
      return true;
    } catch (e) {
      console.warn('[Audio] Microphone access denied:', e);
      return false;
    }
  }

  disableSystemAudio() {
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.systemStream = null;
  }

  disableMicrophone() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
  }

  stopAll() {
    this.disableSystemAudio();
    this.disableMicrophone();
  }
}
