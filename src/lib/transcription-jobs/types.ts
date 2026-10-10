import type { ModelInfo } from "@/lib/ai-model";

export type JobStatus = "queued" | "analyzing" | "transcribing" | "labeling" | "done" | "error";

export type TranscriptionJob = {
  id: string;
  fileName: string;
  size: number;
  language: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  durationSec: number | null;
  analysisProgress: number;
  totalChunks: number;
  completedChunks: number;
  error: string | null;
  /** Whether speaker turns are labeled ("Voce 1:", "Voce 2:") with gpt-4o-mini. */
  labelSpeakers: boolean;
  labeledSegments: number;
  totalSegments: number;
  ai: ModelInfo | null;
  warning: string | null;
};

export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "analyzing", "transcribing", "labeling"];

export const LANGUAGE_OPTIONS = [
  { value: "", label: "Rilevamento automatico" },
  { value: "it", label: "Italiano" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "pt", label: "Português" },
] as const;

export const SUPPORTED_LANGUAGES = new Set<string>(
  LANGUAGE_OPTIONS.map((option) => option.value).filter(Boolean),
);
