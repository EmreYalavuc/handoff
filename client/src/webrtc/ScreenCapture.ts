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
      audio: false,
    });
    return stream;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      return null; // User cancelled
    }
    throw e;
  }
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}
