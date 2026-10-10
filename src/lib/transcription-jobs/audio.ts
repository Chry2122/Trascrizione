import { spawn } from "node:child_process";

export type Silence = { start: number; end: number };
export type ChunkPlan = { index: number; start: number; end: number; skip: boolean };

const SILENCE_NOISE_DB = -35;
const SILENCE_MIN_SEC = 0.5;

const CHUNK_TARGET_SEC = 600;
const CUT_SEARCH_BEFORE_SEC = 90;
const CUT_SEARCH_AFTER_SEC = 60;
// Whisper tends to hallucinate text ("Thanks for watching") on silent input, so near-silent
// chunks are skipped instead of being sent.
const SKIP_SILENCE_RATIO = 0.97;

type RunOptions = {
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

export function runFfmpeg(ffmpegPath: string, args: string[], options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { signal: options.signal, windowsHide: true });
    const stderrTail: string[] = [];

    const forwardLines = (onLine: (line: string) => void) => {
      let buffer = "";
      return (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() ?? "";
        lines.forEach(onLine);
      };
    };

    child.stdout.on("data", forwardLines((line) => options.onStdoutLine?.(line)));
    child.stderr.on(
      "data",
      forwardLines((line) => {
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
        options.onStderrLine?.(line);
      }),
    );

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg terminato con codice ${code}: ${stderrTail.join(" | ")}`));
    });
  });
}

export function parseTimestamp(value: string): number {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

export async function analyzeAudio(
  ffmpegPath: string,
  inputPath: string,
  options: { signal?: AbortSignal; onProgress?: (ratio: number) => void },
): Promise<{ durationSec: number; silences: Silence[] }> {
  let durationSec = 0;
  let processedSec = 0;
  const silences: Silence[] = [];
  let openSilenceStart: number | null = null;

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
      `aformat=channel_layouts=mono,aresample=16000,silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SEC}`,
      "-f",
      "null",
      "-",
    ],
    {
      signal: options.signal,
      onStdoutLine: (line) => {
        const match = /^out_time_us=(\d+)/.exec(line);
        if (!match) return;
        processedSec = Number(match[1]) / 1_000_000;
        if (durationSec > 0) options.onProgress?.(Math.min(processedSec / durationSec, 1));
      },
      onStderrLine: (line) => {
        const duration = /Duration: (\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
        if (duration && durationSec === 0) durationSec = parseTimestamp(duration[1]);

        const start = /silence_start: (-?[\d.]+)/.exec(line);
        if (start) openSilenceStart = Math.max(0, Number(start[1]));

        const end = /silence_end: ([\d.]+)/.exec(line);
        if (end && openSilenceStart !== null) {
          silences.push({ start: openSilenceStart, end: Number(end[1]) });
          openSilenceStart = null;
        }
      },
    },
  );

  if (durationSec === 0) durationSec = processedSec;
  if (openSilenceStart !== null) silences.push({ start: openSilenceStart, end: durationSec });
  if (durationSec <= 0) throw new Error("Impossibile determinare la durata dell'audio.");

  return { durationSec, silences };
}

function silenceCoverage(silences: Silence[], start: number, end: number): number {
  let covered = 0;
  for (const silence of silences) {
    const overlap = Math.min(silence.end, end) - Math.max(silence.start, start);
    if (overlap > 0) covered += overlap;
  }
  return end > start ? covered / (end - start) : 1;
}

export function planChunks(durationSec: number, silences: Silence[]): ChunkPlan[] {
  const cuts: number[] = [];
  let start = 0;

  while (durationSec - start > CHUNK_TARGET_SEC + CUT_SEARCH_AFTER_SEC) {
    const target = start + CHUNK_TARGET_SEC;
    let best: number | null = null;
    for (const silence of silences) {
      const middle = (silence.start + silence.end) / 2;
      if (middle < target - CUT_SEARCH_BEFORE_SEC || middle > target + CUT_SEARCH_AFTER_SEC) {
        continue;
      }
      if (best === null || Math.abs(middle - target) < Math.abs(best - target)) best = middle;
    }
    const cut = best ?? target;
    cuts.push(cut);
    start = cut;
  }

  const boundaries = [0, ...cuts, durationSec];
  return boundaries.slice(0, -1).map((chunkStart, index) => {
    const chunkEnd = boundaries[index + 1];
    return {
      index,
      start: chunkStart,
      end: chunkEnd,
      skip: silenceCoverage(silences, chunkStart, chunkEnd) >= SKIP_SILENCE_RATIO,
    };
  });
}

export async function extractChunk(
  ffmpegPath: string,
  inputPath: string,
  chunk: ChunkPlan,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg(
    ffmpegPath,
    [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      "-ss",
      chunk.start.toFixed(3),
      "-t",
      (chunk.end - chunk.start).toFixed(3),
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "48k",
      "-y",
      outputPath,
    ],
    { signal },
  );
}
