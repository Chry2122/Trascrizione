import type { TierInfo } from "@/lib/tiered-ai";

export type VerificationOutcome =
  | { isCorrect: true }
  | { isCorrect: false; errors: string[]; correctedTranscript: string };

/** `tier` is null when no LLM was needed (the texts already matched after normalization). */
export type VerifyTranscriptResult = VerificationOutcome & { tier: TierInfo | null };

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
