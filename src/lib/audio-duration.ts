const METADATA_TIMEOUT_MS = 10_000;

/**
 * Reads the duration of an audio/video file in the browser from its metadata only (no
 * decoding, no network). Resolves to null when the browser cannot tell.
 */
export function readMediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const finish = (duration: number | null) => {
      clearTimeout(timer);
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
      resolve(duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    const timer = setTimeout(() => finish(null), METADATA_TIMEOUT_MS);
    media.preload = "metadata";
    media.onloadedmetadata = () => finish(media.duration);
    media.onerror = () => finish(null);
    media.src = url;
  });
}
