import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import { toFile } from "openai";
import { analyzeAudio, extractChunk, planChunks } from "@/lib/transcription-jobs/audio";
import { STYLE_PROMPTS } from "@/lib/transcription-jobs/style-prompts";

const CHUNK_CONCURRENCY = 3;
const WHISPER_TIMEOUT_MS = 10 * 60 * 1000;

export type TranscriptionProgress =
  | { stage: "analyzing"; ratio: number }
  | { stage: "transcribing"; done: number; total: number };

/**
 * Transcribes an audio file of any length: it is split on pauses into ~10 minute chunks that
 * stay under the Whisper size limit. Each chunk is sent exactly once (no retries); the first
 * failure or an abort stops all remaining work.
 */
export async function transcribeAudioFile(options: {
  openai: OpenAI;
  ffmpegPath: string;
  inputPath: string;
  workDir: string;
  language: string | null;
  signal: AbortSignal;
  onProgress: (progress: TranscriptionProgress) => void;
}): Promise<string> {
  const { openai, ffmpegPath, inputPath, workDir, language, signal, onProgress } = options;

  let lastRatio = 0;
  const { durationSec, silences } = await analyzeAudio(ffmpegPath, inputPath, {
    signal,
    onProgress: (ratio) => {
      if (ratio - lastRatio < 0.02) return;
      lastRatio = ratio;
      onProgress({ stage: "analyzing", ratio });
    },
  });
  const chunks = planChunks(durationSec, silences);
  const pending = chunks.filter((chunk) => !chunk.skip);
  const total = pending.length;
  const texts: string[] = new Array(chunks.length).fill("");
  const prompt = language ? STYLE_PROMPTS[language] : undefined;

  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop);
  let done = 0;
  let failure: unknown = null;
  onProgress({ stage: "transcribing", done, total });

  const worker = async () => {
    while (pending.length > 0 && failure === null && !controller.signal.aborted) {
      const chunk = pending.shift()!;
      const audioPath = path.join(workDir, `chunk-${chunk.index}.mp3`);
      try {
        await extractChunk(ffmpegPath, inputPath, chunk, audioPath, controller.signal);
        const file = await toFile(await readFile(audioPath), `chunk-${chunk.index}.mp3`, {
          type: "audio/mpeg",
        });
        const result = await openai.audio.transcriptions.create(
          {
            file,
            model: "whisper-1",
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
          },
          { signal: controller.signal, timeout: WHISPER_TIMEOUT_MS, maxRetries: 0 },
        );
        texts[chunk.index] = (result.text ?? "").trim();
        done += 1;
        onProgress({ stage: "transcribing", done, total });
      } catch (error: unknown) {
        failure ??= error;
        controller.abort();
      } finally {
        await rm(audioPath, { force: true });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, worker));
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw new Error("Operazione annullata.");
  if (failure !== null) throw failure;
  return texts.filter(Boolean).join("\n\n");
}
