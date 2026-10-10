import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TMP_ROOT } from "@/lib/tmp-root";
import type { ChunkPlan } from "@/lib/transcription-jobs/audio";
import { ACTIVE_STATUSES, type TranscriptionJob } from "@/lib/transcription-jobs/types";

export type StoredJob = TranscriptionJob & {
  sourceExtension: string;
  chunks: ChunkPlan[] | null;
};

type StoreState = {
  jobs: Map<string, StoredJob>;
  writeQueues: Map<string, Promise<void>>;
  loading: Promise<string[]> | null;
};

const DATA_DIR = path.join(TMP_ROOT, "transcriptions");

const globalStore = globalThis as typeof globalThis & { __transcriptionStore?: StoreState };
const state: StoreState = (globalStore.__transcriptionStore ??= {
  jobs: new Map(),
  writeQueues: new Map(),
  loading: null,
});

export function jobDir(id: string): string {
  return path.join(DATA_DIR, id);
}

export function sourcePath(job: StoredJob): string {
  return path.join(DATA_DIR, job.id, `source${job.sourceExtension}`);
}

export function chunkAudioPath(id: string, index: number): string {
  return path.join(DATA_DIR, id, "chunks", `${String(index).padStart(4, "0")}.mp3`);
}

export function chunkTextPath(id: string, index: number): string {
  return path.join(DATA_DIR, id, "chunks", `${String(index).padStart(4, "0")}.txt`);
}

export function transcriptPath(id: string): string {
  return path.join(DATA_DIR, id, "transcript.txt");
}

export function rawTranscriptPath(id: string): string {
  return path.join(DATA_DIR, id, "transcript-whisper.txt");
}

export function labeledSegmentPath(id: string, index: number): string {
  return path.join(DATA_DIR, id, "speakers", `${String(index).padStart(4, "0")}.json`);
}

export function toPublicJob(job: StoredJob): TranscriptionJob {
  return {
    id: job.id,
    fileName: job.fileName,
    size: job.size,
    language: job.language,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationSec: job.durationSec,
    analysisProgress: job.analysisProgress,
    totalChunks: job.totalChunks,
    completedChunks: job.completedChunks,
    error: job.error,
    labelSpeakers: job.labelSpeakers ?? false,
    labeledSegments: job.labeledSegments ?? 0,
    totalSegments: job.totalSegments ?? 0,
    ai: job.ai ?? null,
    warning: job.warning ?? null,
  };
}

function persist(job: StoredJob): Promise<void> {
  const metaPath = path.join(DATA_DIR, job.id, "meta.json");
  const snapshot = JSON.stringify(job, null, 2);
  const previous = state.writeQueues.get(job.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (!state.jobs.has(job.id)) return;
      await writeFile(`${metaPath}.tmp`, snapshot, "utf8");
      await rename(`${metaPath}.tmp`, metaPath);
    });
  state.writeQueues.set(job.id, next);
  return next;
}

/**
 * Loads persisted jobs once. Jobs interrupted mid-processing are NOT resumed automatically:
 * they are marked as failed so that only an explicit "Riprova" click calls the API again.
 */
export function ensureLoaded(): Promise<string[]> {
  state.loading ??= (async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const interrupted: string[] = [];
    for (const entry of await readdir(DATA_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || state.jobs.has(entry.name)) continue;
      try {
        const raw = await readFile(path.join(DATA_DIR, entry.name, "meta.json"), "utf8");
        const job = JSON.parse(raw) as StoredJob;
        state.jobs.set(job.id, job);
        if (ACTIVE_STATUSES.includes(job.status)) {
          job.status = "error";
          job.error = "Interrotta dal riavvio del server. Premi \"Riprova\" per continuare da dove si era fermata.";
          interrupted.push(job.id);
          await persist(job);
        }
      } catch {
        // Incomplete upload or corrupted metadata: nothing to resume.
        await rm(path.join(DATA_DIR, entry.name), { recursive: true, force: true });
      }
    }
    return interrupted;
  })();
  return state.loading;
}

export async function createUploadDir(): Promise<{ id: string; dir: string }> {
  const id = randomUUID();
  const dir = jobDir(id);
  await mkdir(path.join(dir, "chunks"), { recursive: true });
  return { id, dir };
}

export async function createJob(input: {
  id: string;
  fileName: string;
  size: number;
  language: string | null;
  sourceExtension: string;
  labelSpeakers: boolean;
}): Promise<StoredJob> {
  const now = new Date().toISOString();
  const job: StoredJob = {
    ...input,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    durationSec: null,
    analysisProgress: 0,
    totalChunks: 0,
    completedChunks: 0,
    error: null,
    labeledSegments: 0,
    totalSegments: 0,
    ai: null,
    warning: null,
    chunks: null,
  };
  state.jobs.set(job.id, job);
  await persist(job);
  return job;
}

export function getJob(id: string): StoredJob | undefined {
  return state.jobs.get(id);
}

export function listJobs(): StoredJob[] {
  return [...state.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function updateJob(id: string, patch: Partial<StoredJob>): Promise<StoredJob | null> {
  const job = state.jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  await persist(job);
  return job;
}

export async function deleteJob(id: string): Promise<void> {
  state.jobs.delete(id);
  await state.writeQueues.get(id)?.catch(() => undefined);
  state.writeQueues.delete(id);
  await rm(jobDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
