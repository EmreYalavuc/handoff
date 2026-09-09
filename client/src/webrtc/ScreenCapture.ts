/**
 * Wraps getDisplayMedia with clean error handling.
 * Returns null if user cancels or permission denied.
 */
export async function captureScreen(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: true,
    });
    return stream;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      return null;
    }
    // Some browsers/OS reject audio=true — retry without audio
    if (e instanceof DOMException && (e.name === 'NotSupportedError' || e.name === 'TypeError')) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        return stream;
      } catch {
        return null;
      }
    }
    throw e;
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}
