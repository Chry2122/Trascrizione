import type { TranscriptionJob } from "@/lib/transcription-jobs/types";

// Rough timings used only for the first estimate in the UI; the progress bar then corrects
// itself with the speed actually measured. Chunk size and concurrency mirror the server.
const CHUNK_SEC = 600;
const CHUNK_CONCURRENCY = 3;
const WHISPER_SEC_PER_CHUNK = 40;
const SILENCE_ANALYSIS_SPEED = 200;
const CHARS_PER_AUDIO_SEC = 14;
const DIARIZATION_SEGMENT_CHARS = 3000;
const DIARIZATION_SEC_PER_SEGMENT = 12;
const SHORT_COMPARE_SEC = 25;
const LONG_COMPARE_SEC = 45;
const SHORT_COMPARE_MAX_CHARS = 12_000;

export type StageEstimate = { analysis: number; transcription: number; extra: number };

function chunkCount(durationSec: number): number {
  return Math.max(1, Math.ceil(durationSec / CHUNK_SEC));
}

function baseStages(durationSec: number): Pick<StageEstimate, "analysis" | "transcription"> {
  return {
    analysis: 3 + durationSec / SILENCE_ANALYSIS_SPEED,
    transcription: Math.ceil(chunkCount(durationSec) / CHUNK_CONCURRENCY) * WHISPER_SEC_PER_CHUNK,
  };
}

export type ProgressEstimate = {
  /** Real completion, 0..1, from the steps the server reported. */
  progress: number;
  /** How far the bar may move on its own before the next server update. */
  step: number;
  /** Estimated total processing time in seconds, null when the duration is unknown. */
  totalSec: number | null;
};

function combine(
  stages: StageEstimate,
  ratios: StageEstimate,
  steps: StageEstimate,
  known: boolean,
): ProgressEstimate {
  const total = stages.analysis + stages.transcription + stages.extra;
  const weighted = (values: StageEstimate) =>
    (stages.analysis * values.analysis + stages.transcription * values.transcription + stages.extra * values.extra) /
    total;
  return { progress: weighted(ratios), step: weighted(steps), totalSec: known ? total : null };
}

/** Overall progress of a background transcription job, speaker labelling included. */
export function estimateJobProgress(job: TranscriptionJob, fallbackDurationSec: number | null): ProgressEstimate {
  const durationSec = job.durationSec ?? fallbackDurationSec;
  const known = durationSec !== null;
  const base = baseStages(durationSec ?? CHUNK_SEC);
  const segments = Math.max(
    1,
    job.totalSegments || Math.ceil(((durationSec ?? CHUNK_SEC) * CHARS_PER_AUDIO_SEC) / DIARIZATION_SEGMENT_CHARS),
  );
  const stages: StageEstimate = {
    ...base,
    extra: job.labelSpeakers ? segments * DIARIZATION_SEC_PER_SEGMENT : 0,
  };
  const chunks = Math.max(1, job.totalChunks || chunkCount(durationSec ?? CHUNK_SEC));
  const none: StageEstimate = { analysis: 0, transcription: 0, extra: 0 };

  switch (job.status) {
    case "queued":
      return combine(stages, none, { ...none, analysis: 0.5 }, known);
    case "analyzing":
      return combine(
        stages,
        { ...none, analysis: job.analysisProgress },
        { ...none, analysis: 1 - job.analysisProgress },
        known,
      );
    case "transcribing": {
      const ratio = job.completedChunks / chunks;
      return combine(
        stages,
        { ...none, analysis: 1, transcription: ratio },
        { ...none, transcription: Math.min(1 - ratio, CHUNK_CONCURRENCY / chunks) },
        known,
      );
    }
    case "labeling":
      return combine(
        stages,
        { analysis: 1, transcription: 1, extra: job.labeledSegments / segments },
        { ...none, extra: 1 / segments },
        known,
      );
    default:
      return { progress: 1, step: 0, totalSec: null };
  }
}

export type VerifyStage =
  | { stage: "preparing" }
  | { stage: "analyzing"; ratio: number }
  | { stage: "transcribing"; done: number; total: number }
  | { stage: "comparing"; done: number; total: number };

/** Overall progress of a verification: Whisper on the audio, then the gpt-4o comparison. */
export function estimateVerifyProgress(
  current: VerifyStage,
  durationSec: number | null,
  transcriptChars: number,
): ProgressEstimate {
  const known = durationSec !== null;
  const audioSec = durationSec ?? CHUNK_SEC;
  const compareSec =
    transcriptChars + audioSec * CHARS_PER_AUDIO_SEC <= SHORT_COMPARE_MAX_CHARS
      ? SHORT_COMPARE_SEC
      : LONG_COMPARE_SEC;
  const stages: StageEstimate = { ...baseStages(audioSec), extra: compareSec };
  const none: StageEstimate = { analysis: 0, transcription: 0, extra: 0 };

  switch (current.stage) {
    case "preparing":
      return combine(stages, none, { ...none, analysis: 0.5 }, known);
    case "analyzing":
      return combine(
        stages,
        { ...none, analysis: current.ratio },
        { ...none, analysis: 1 - current.ratio },
        known,
      );
    case "transcribing": {
      const total = Math.max(1, current.total);
      const ratio = current.done / total;
      return combine(
        stages,
        { ...none, analysis: 1, transcription: ratio },
        { ...none, transcription: Math.min(1 - ratio, CHUNK_CONCURRENCY / total) },
        known,
      );
    }
    case "comparing": {
      const total = Math.max(1, current.total);
      return combine(
        stages,
        { analysis: 1, transcription: 1, extra: current.done / total },
        { ...none, extra: 1 / total },
        known,
      );
    }
  }
}
