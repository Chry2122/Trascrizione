import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthenticationError, toFile } from "openai";
import { FFMPEG_MISSING_MESSAGE, resolveFfmpegPath } from "@/lib/ffmpeg-binary";
import { createOpenAIClient } from "@/lib/openai-server";
import {
  diarizeSegment,
  INITIAL_DIARIZATION_STATE,
  joinDiarizedSegments,
  splitForDiarization,
  type DiarizedSegment,
} from "@/lib/speaker-diarization";
import { mergeModelInfo } from "@/lib/ai-model";
import { analyzeAudio, extractChunk, planChunks, type ChunkPlan } from "@/lib/transcription-jobs/audio";
import {
  chunkAudioPath,
  chunkTextPath,
  ensureLoaded,
  getJob,
  jobDir,
  labeledSegmentPath,
  rawTranscriptPath,
  sourcePath,
  transcriptPath,
  updateJob,
  type StoredJob,
} from "@/lib/transcription-jobs/store";
import { STYLE_PROMPTS } from "@/lib/transcription-jobs/style-prompts";

const LOG_PREFIX = "[transcription-jobs]";
const CHUNK_CONCURRENCY = 3;
const WHISPER_TIMEOUT_MS = 10 * 60 * 1000;

type OpenAIClient = NonNullable<ReturnType<typeof createOpenAIClient>>;

type WorkerState = {
  queue: string[];
  running: boolean;
  controllers: Map<string, AbortController>;
  initialized: Promise<void> | null;
};

const globalWorker = globalThis as typeof globalThis & { __transcriptionWorker?: WorkerState };
const worker: WorkerState = (globalWorker.__transcriptionWorker ??= {
  queue: [],
  running: false,
  controllers: new Map(),
  initialized: null,
});

class JobFailure extends Error {}

/**
 * Loads persisted jobs once per process. Interrupted jobs are never resumed here: they wait
 * for the user to press "Riprova", so no API call starts without an explicit click.
 */
export function initJobs(): Promise<void> {
  worker.initialized ??= ensureLoaded().then((interrupted) => {
    for (const id of interrupted) {
      console.log(`${LOG_PREFIX} lavoro interrotto ${id}: in attesa di "Riprova"`);
    }
  });
  return worker.initialized;
}

export function enqueueJob(id: string): void {
  if (!worker.queue.includes(id) && !worker.controllers.has(id)) worker.queue.push(id);
  void drainQueue();
}

export function cancelJob(id: string): void {
  worker.queue = worker.queue.filter((queued) => queued !== id);
  worker.controllers.get(id)?.abort();
}

async function drainQueue(): Promise<void> {
  if (worker.running) return;
  worker.running = true;
  try {
    while (worker.queue.length > 0) {
      const id = worker.queue.shift()!;
      await processJob(id);
    }
  } finally {
    worker.running = false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function processJob(id: string): Promise<void> {
  const job = getJob(id);
  if (!job || job.status === "done" || job.status === "error") return;

  const controller = new AbortController();
  worker.controllers.set(id, controller);
  const startedAt = Date.now();

  try {
    const ffmpeg = resolveFfmpegPath(LOG_PREFIX);
    if (!ffmpeg) throw new JobFailure(FFMPEG_MISSING_MESSAGE);
    const openai = createOpenAIClient();
    if (!openai) throw new JobFailure("OPENAI_API_KEY non configurata.");

    const chunks = job.chunks ?? (await analyze(job, ffmpeg.path, controller.signal));

    const pending: ChunkPlan[] = [];
    for (const chunk of chunks) {
      if (!(await fileExists(chunkTextPath(id, chunk.index)))) pending.push(chunk);
    }
    await updateJob(id, {
      status: "transcribing",
      completedChunks: chunks.length - pending.length,
    });
    console.log(
      `${LOG_PREFIX} ${job.fileName}: ${pending.length}/${chunks.length} blocchi da trascrivere`,
    );

    let completed = chunks.length - pending.length;
    let failure: unknown = null;
    const transcribeNext = async () => {
      while (pending.length > 0 && failure === null && !controller.signal.aborted) {
        const chunk = pending.shift()!;
        try {
          const text = chunk.skip
            ? ""
            : await transcribeChunk(job, chunk, ffmpeg.path, openai, controller.signal);
          await writeFile(chunkTextPath(id, chunk.index), text, "utf8");
          completed += 1;
          await updateJob(id, { completedChunks: completed });
        } catch (error: unknown) {
          failure ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, transcribeNext));
    if (controller.signal.aborted) return;
    if (failure !== null) throw failure;

    const texts = await Promise.all(
      chunks.map((chunk) => readFile(chunkTextPath(id, chunk.index), "utf8")),
    );
    const rawTranscript = texts.map((text) => text.trim()).filter(Boolean).join("\n\n");
    await writeFile(rawTranscriptPath(id), rawTranscript, "utf8");
    const transcript =
      job.labelSpeakers && rawTranscript
        ? await labelSpeakers(job, rawTranscript, openai, controller.signal)
        : rawTranscript;
    await writeFile(transcriptPath(id), transcript, "utf8");
    await updateJob(id, { status: "done", error: null });
    await Promise.all([
      rm(sourcePath(job), { force: true }),
      rm(path.join(jobDir(id), "chunks"), { recursive: true, force: true }),
      rm(path.join(jobDir(id), "speakers"), { recursive: true, force: true }),
    ]);
    console.log(
      `${LOG_PREFIX} ${job.fileName}: completato in ${Math.round((Date.now() - startedAt) / 1000)} s`,
    );
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      console.log(`${LOG_PREFIX} ${job.fileName}: annullato`);
      return;
    }
    const message = describeError(error);
    console.error(`${LOG_PREFIX} ${job.fileName}: fallito - ${message}`);
    await updateJob(id, { status: "error", error: message });
  } finally {
    worker.controllers.delete(id);
  }
}

async function analyze(job: StoredJob, ffmpegPath: string, signal: AbortSignal) {
  await updateJob(job.id, { status: "analyzing", analysisProgress: 0 });
  let lastReported = 0;
  const { durationSec, silences } = await analyzeAudio(ffmpegPath, sourcePath(job), {
    signal,
    onProgress: (ratio) => {
      if (ratio - lastReported < 0.02) return;
      lastReported = ratio;
      void updateJob(job.id, { analysisProgress: ratio });
    },
  });
  const chunks = planChunks(durationSec, silences);
  await updateJob(job.id, {
    durationSec,
    chunks,
    totalChunks: chunks.length,
    analysisProgress: 1,
  });
  console.log(
    `${LOG_PREFIX} ${job.fileName}: ${Math.round(durationSec / 60)} min, ${silences.length} pause, ${chunks.length} blocchi (${chunks.filter((c) => c.skip).length} silenziosi)`,
  );
  return chunks;
}

/**
 * Labels the speaker turns segment after segment (one gpt-4o-mini call each). Every result
 * is saved, so "Riprova" after an interruption continues from the next segment.
 */
async function labelSpeakers(
  job: StoredJob,
  rawTranscript: string,
  openai: OpenAIClient,
  signal: AbortSignal,
): Promise<string> {
  const segments = splitForDiarization(rawTranscript);
  await mkdir(path.join(jobDir(job.id), "speakers"), { recursive: true });
  await updateJob(job.id, { status: "labeling", totalSegments: segments.length, labeledSegments: 0 });

  const results: DiarizedSegment[] = [];
  let state = INITIAL_DIARIZATION_STATE;
  for (const [index, segment] of segments.entries()) {
    if (signal.aborted) throw new Error("Operazione annullata.");
    const savedPath = labeledSegmentPath(job.id, index);
    const saved = await readFile(savedPath, "utf8").then(
      (raw) => JSON.parse(raw) as DiarizedSegment,
      () => null,
    );
    const result = saved ?? (await diarizeSegment(openai, segment, state, signal));
    if (!saved) await writeFile(savedPath, JSON.stringify(result), "utf8");
    results.push(result);
    state = result.state;
    await updateJob(job.id, { labeledSegments: index + 1 });
  }

  const unlabeled = results.filter((result) => !result.labeled).length;
  await updateJob(job.id, {
    ai: mergeModelInfo(results.flatMap((result) => (result.ai ? [result.ai] : []))),
    warning:
      unlabeled > 0
        ? `${unlabeled} segmenti su ${segments.length} sono rimasti senza etichette dei parlanti.`
        : null,
  });
  console.log(
    `${LOG_PREFIX} ${job.fileName}: parlanti riconosciuti in ${segments.length - unlabeled}/${segments.length} segmenti`,
  );
  return joinDiarizedSegments(results);
}

async function transcribeChunk(
  job: StoredJob,
  chunk: ChunkPlan,
  ffmpegPath: string,
  openai: OpenAIClient,
  signal: AbortSignal,
): Promise<string> {
  const prompt = job.language ? STYLE_PROMPTS[job.language] : undefined;
  const audioPath = chunkAudioPath(job.id, chunk.index);
  await extractChunk(ffmpegPath, sourcePath(job), chunk, audioPath, signal);
  try {
    const file = await toFile(await readFile(audioPath), `chunk-${chunk.index}.mp3`, {
      type: "audio/mpeg",
    });
    const result = await openai.audio.transcriptions.create(
      {
        file,
        model: "whisper-1",
        ...(job.language ? { language: job.language } : {}),
        ...(prompt ? { prompt } : {}),
      },
      { signal, timeout: WHISPER_TIMEOUT_MS, maxRetries: 0 },
    );
    return result.text ?? "";
  } finally {
    await rm(audioPath, { force: true });
  }
}

function describeError(error: unknown): string {
  if (error instanceof AuthenticationError) return "API key OpenAI non valida. Controlla OPENAI_API_KEY.";
  if (error instanceof Error) return error.message;
  return "Errore sconosciuto.";
}
