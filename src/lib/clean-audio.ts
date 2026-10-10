export type CleanOutputFormat = "wav" | "flac" | "mp3";

export const CLEAN_OUTPUT_FORMATS: {
  value: CleanOutputFormat;
  label: string;
  hint: string;
  mimeType: string;
}[] = [
  { value: "wav", label: "WAV", hint: "qualità piena, circa 10 MB al minuto", mimeType: "audio/wav" },
  { value: "flac", label: "FLAC", hint: "senza perdita, circa metà del WAV", mimeType: "audio/flac" },
  { value: "mp3", label: "MP3 192 kbps", hint: "compatto, circa 1,4 MB al minuto", mimeType: "audio/mpeg" },
];

export function isCleanOutputFormat(value: string): value is CleanOutputFormat {
  return CLEAN_OUTPUT_FORMATS.some((format) => format.value === value);
}

export type CleanResult = {
  id: string;
  fileName: string;
  format: CleanOutputFormat;
  size: number;
};

export type CleanStreamEvent =
  | { type: "progress"; ratio: number }
  | ({ type: "done" } & CleanResult)
  | { type: "error"; error: string };
