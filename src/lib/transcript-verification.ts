import type { ModelInfo } from "@/lib/ai-model";

export type VerificationOutcome =
  | { isCorrect: true }
  | { isCorrect: false; errors: string[]; correctedTranscript: string };

/**
 * `ai` is null when no model was needed (the texts already matched after normalization).
 * `speakerTimes` is the estimated start, in seconds, of the first turn of each speaker label.
 */
export type VerifyTranscriptResult = VerificationOutcome & {
  ai: ModelInfo | null;
  speakerTimes?: Record<string, number> | null;
};

export type VerifyRequestBody = {
  uploadId: string;
  providedTranscript: string;
  language: string;
};

export type VerifyStreamEvent =
  | { type: "progress"; stage: "analyzing"; ratio: number }
  | { type: "progress"; stage: "transcribing"; done: number; total: number }
  | { type: "progress"; stage: "comparing"; done: number; total: number }
  | { type: "result"; result: VerifyTranscriptResult }
  | { type: "error"; error: string };
