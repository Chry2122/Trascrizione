const MB = 1024 * 1024;
const GB = 1024 * MB;

export const WHISPER_MAX_FILE_BYTES = 25 * MB;

export type MediaFormats = {
  extensions: readonly string[];
  mimeTypes: readonly string[];
  maxBytes: number;
  /** Set when `maxBytes` is lowered by the hosting platform rather than by the app. */
  hostingLimited?: boolean;
};

const APP_MAX_UPLOAD_BYTES = 8 * GB;
// Empty when the hosting accepts uploads of any size (local server, dedicated server).
const HOSTING_MAX_UPLOAD_BYTES = Number(process.env.NEXT_PUBLIC_HOSTING_MAX_UPLOAD_BYTES) || null;

const AUDIO_MIME_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"];
const VIDEO_MIME_TYPES = ["audio/mp4", "video/mp4", "audio/webm", "video/webm"];

export const TRANSCRIBE_FORMATS: MediaFormats = {
  extensions: [".mp3", ".wav", ".mp4", ".webm"],
  mimeTypes: [...AUDIO_MIME_TYPES, ...VIDEO_MIME_TYPES],
  maxBytes: WHISPER_MAX_FILE_BYTES,
};

export const LONG_TRANSCRIBE_FORMATS: MediaFormats = {
  extensions: [".mp3", ".wav", ".m4a", ".mp4", ".webm"],
  mimeTypes: [...AUDIO_MIME_TYPES, ...VIDEO_MIME_TYPES, "audio/x-m4a", "audio/m4a"],
  ...(HOSTING_MAX_UPLOAD_BYTES !== null && HOSTING_MAX_UPLOAD_BYTES < APP_MAX_UPLOAD_BYTES
    ? { maxBytes: HOSTING_MAX_UPLOAD_BYTES, hostingLimited: true }
    : { maxBytes: APP_MAX_UPLOAD_BYTES }),
};

export const CLEAN_FORMATS: MediaFormats = LONG_TRANSCRIBE_FORMATS;

export const VERIFY_FORMATS: MediaFormats = LONG_TRANSCRIBE_FORMATS;

// About 7 hours of speech is 400-500k characters.
export const MAX_TRANSCRIPT_CHARS = 2_000_000;

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot).toLowerCase();
}

export function formatList(formats: MediaFormats): string {
  return formats.extensions.join(", ");
}

export function acceptAttribute(formats: MediaFormats): string {
  return [...formats.mimeTypes, ...formats.extensions].join(",");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}

/** For a 413 that did not come from the app (no JSON body): the hosting rejected the request. */
export const HOSTING_TOO_LARGE_MESSAGE =
  "Il file è stato rifiutato dall'hosting prima di arrivare all'app: su Vercel ogni richiesta può essere al massimo di 4,5 MB, qualunque sia il limite dell'app. Per file grandi avvia l'app in locale (npm run dev) o su un server dedicato.";

export function validateMediaMeta(
  meta: { name: string; type: string; size: number },
  formats: MediaFormats,
): string | null {
  if (meta.size === 0) {
    return "Il file è vuoto.";
  }
  if (meta.size > formats.maxBytes) {
    return formats.hostingLimited
      ? `Il file (${formatBytes(meta.size)}) supera il limite di ${formatBytes(formats.maxBytes)} imposto dall'hosting: Vercel non accetta richieste più grandi di 4,5 MB. Per file grandi avvia l'app in locale (npm run dev) o su un server dedicato.`
      : `Il file supera la dimensione massima consentita (${formatBytes(formats.maxBytes)}).`;
  }
  if (!formats.extensions.includes(getExtension(meta.name))) {
    return `Formato non supportato. Sono ammessi solo: ${formatList(formats)}.`;
  }
  const mime = meta.type.toLowerCase();
  if (mime && !formats.mimeTypes.includes(mime)) {
    return `Tipo di file non supportato (${mime}). Sono ammessi solo: ${formatList(formats)}.`;
  }
  return null;
}

export function validateMediaFile(file: File, formats: MediaFormats): string | null {
  return validateMediaMeta(file, formats);
}
