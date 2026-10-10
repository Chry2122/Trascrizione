import { existsSync } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

export type FfmpegBinary = { path: string; source: string };

let cached: FfmpegBinary | null = null;

// When bundled, ffmpeg-static computes its path from a rewritten __dirname that may not exist,
// and it cannot be a server external package on filesystems without symlinks (exFAT).
export function resolveFfmpegPath(logPrefix = "[ffmpeg]"): FfmpegBinary | null {
  if (cached && existsSync(/*turbopackIgnore: true*/ cached.path)) return cached;

  const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates: { path: string | null | undefined; source: string }[] = [
    { path: process.env.FFMPEG_PATH, source: "FFMPEG_PATH" },
    { path: ffmpegStatic, source: "ffmpeg-static" },
    {
      path: path.join(process.cwd(), "node_modules", "ffmpeg-static", binary),
      source: "node_modules/ffmpeg-static",
    },
  ];

  for (const candidate of candidates) {
    if (!candidate.path) continue;
    if (existsSync(/*turbopackIgnore: true*/ candidate.path)) {
      cached = { path: candidate.path, source: candidate.source };
      return cached;
    }
    console.log(`${logPrefix} binario non trovato (${candidate.source}): ${candidate.path}`);
  }
  return null;
}

export const FFMPEG_MISSING_MESSAGE =
  "Binario ffmpeg non trovato. Esegui `npm rebuild ffmpeg-static` oppure imposta FFMPEG_PATH.";
