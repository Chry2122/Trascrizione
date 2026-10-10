import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isCleanOutputFormat, type CleanOutputFormat, type CleanStreamEvent } from "@/lib/clean-audio";
import { FFMPEG_MISSING_MESSAGE, resolveFfmpegPath } from "@/lib/ffmpeg-binary";
import { CLEAN_FORMATS, formatBytes } from "@/lib/media-validation";
import { ndjsonResponse } from "@/lib/ndjson-response";
import { receiveRawUpload, UploadError } from "@/lib/raw-upload";
import { createStorageDir, removeStorageDir, sweepOldStorage } from "@/lib/temp-storage";
import { parseTimestamp, runFfmpeg } from "@/lib/transcription-jobs/audio";

export const runtime = "nodejs";

const LOG_PREFIX = "[clean-audio]";

// afftdn only accepts nf in [-80, -20]; anything above -20 makes ffmpeg abort the whole graph.
// loudnorm upsamples to 192 kHz internally, so aresample brings the output back to 44.1 kHz.
const NOISE_FILTERS = [
  "highpass=f=150",
  "lowpass=f=5500",
  "afftdn=nr=35:nf=-20:tn=1",
  "equalizer=f=1500:width_type=h:width=1000:g=6",
  "acompressor=threshold=-16dB:ratio=4:attack=10:release=100",
  "loudnorm",
  "aresample=44100",
];

// RF64 lets WAV files grow past the 4 GB RIFF limit (about 6.7 h of 44.1 kHz stereo).
const CODEC_ARGS: Record<CleanOutputFormat, string[]> = {
  wav: ["-c:a", "pcm_s16le", "-rf64", "auto", "-f", "wav"],
  flac: ["-c:a", "flac", "-f", "flac"],
  mp3: ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"],
};

async function runNoiseReduction(
  ffmpegPath: string,
  inputPath: string,
  outputPath: string,
  format: CleanOutputFormat,
  signal: AbortSignal,
  onProgress: (ratio: number) => void,
): Promise<void> {
  let durationSec = 0;
  let lastReported = 0;
  const startedAt = Date.now();
  await runFfmpeg(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostats",
      "-progress",
      "pipe:1",
      "-i",
      inputPath,
      "-vn",
      "-af",
      NOISE_FILTERS.join(","),
      ...CODEC_ARGS[format],
      "-y",
      outputPath,
    ],
    {
      signal,
      onStderrLine: (line) => {
        const duration = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
        if (duration && durationSec === 0) durationSec = parseTimestamp(duration[1]);
      },
      onStdoutLine: (line) => {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match || durationSec <= 0) return;
        const ratio = Math.min(Number(match[1]) / 1_000_000 / durationSec, 1);
        if (ratio - lastReported < 0.01) return;
        lastReported = ratio;
        onProgress(ratio);
      },
    },
  );
  console.log(`${LOG_PREFIX} ffmpeg completato in ${Math.round((Date.now() - startedAt) / 1000)} s`);
}

/**
 * Receives the raw file, cleans it with ffmpeg and streams the progress as NDJSON. The
 * result stays on disk and is served by /api/clean-audio/[id].
 */
export async function POST(request: NextRequest) {
  const ffmpegBinary = resolveFfmpegPath(LOG_PREFIX);
  if (!ffmpegBinary) {
    return NextResponse.json({ error: FFMPEG_MISSING_MESSAGE }, { status: 500 });
  }

  const format = request.headers.get("x-output-format") ?? "wav";
  if (!isCleanOutputFormat(format)) {
    return NextResponse.json({ error: `Formato di uscita non supportato: ${format}.` }, { status: 400 });
  }

  void sweepOldStorage("clean");
  const { id, dir } = await createStorageDir("clean");
  let upload;
  try {
    upload = await receiveRawUpload(request, CLEAN_FORMATS, dir);
  } catch (error: unknown) {
    await removeStorageDir("clean", id);
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  console.log(`${LOG_PREFIX} ricevuto "${upload.fileName}" (${formatBytes(upload.size)}), uscita ${format}`);

  const outputPath = path.join(dir, `output.${format}`);
  return ndjsonResponse<CleanStreamEvent>(
    request,
    async (send, signal) => {
      try {
        await runNoiseReduction(ffmpegBinary.path, upload.path, outputPath, format, signal, (ratio) =>
          send({ type: "progress", ratio }),
        );
        await rm(upload.path, { force: true });
        const output = await stat(outputPath).catch(() => null);
        if (!output || output.size <= 44) throw new Error("ffmpeg non ha prodotto un file audio valido.");

        const result = { id, fileName: upload.fileName, format, size: output.size };
        await writeFile(path.join(dir, "meta.json"), JSON.stringify(result), "utf8");
        console.log(`${LOG_PREFIX} output ${formatBytes(output.size)} (input ${formatBytes(upload.size)})`);
        send({ type: "done", ...result });
      } catch (error: unknown) {
        await removeStorageDir("clean", id);
        if (signal.aborted) console.log(`${LOG_PREFIX} annullato dal client`);
        throw error;
      }
    },
    (error) => {
      const message = error instanceof Error ? error.message : "Errore sconosciuto.";
      console.error(`${LOG_PREFIX} elaborazione fallita: ${message}`);
      return `Elaborazione audio fallita: ${message}`;
    },
  );
}
