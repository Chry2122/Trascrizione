import type OpenAI from "openai";

/** Speaker labelling after Whisper: fast and cheap, meant for volume. */
export const DIARIZATION_MODEL = "gpt-4o-mini";
/** Comparison between the audio (Whisper) and the transcript provided by the user. */
export const VERIFICATION_MODEL = "gpt-4o";

/** Serializable metadata about the model calls behind a result, exposed to API clients. */
export type ModelInfo = {
  model: string;
  /** Number of model calls (segments or batches) that produced the result. */
  calls: number;
};

export class ModelResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelResponseError";
  }
}

export type JsonTaskOptions<T> = {
  client: OpenAI;
  model: string;
  /** Short label used in logs, e.g. "verify-transcript". */
  taskName: string;
  /** System prompt; it must describe the JSON object to return. */
  instructions: string;
  input: string;
  maxOutputTokens: number;
  /** Validates and extracts the result; null marks the response as unusable. */
  parse: (record: Record<string, unknown>) => T | null;
  signal?: AbortSignal;
};

/**
 * Runs a JSON task with exactly one call to the given model: no retries, no fallback to
 * other models. An unusable answer throws ModelResponseError.
 */
export async function runJsonTask<T>(options: JsonTaskOptions<T>): Promise<T> {
  const { client, model, taskName, signal } = options;
  const startedAt = Date.now();
  const completion = await client.chat.completions.create(
    {
      model,
      temperature: 0,
      max_completion_tokens: options.maxOutputTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: options.instructions },
        { role: "user", content: options.input },
      ],
    },
    { signal, maxRetries: 0 },
  );
  const choice = completion.choices[0];
  console.log(`[ai] ${taskName} | model=${model} | ${Date.now() - startedAt}ms`);
  if (choice?.finish_reason === "length") {
    throw new ModelResponseError(`${model}: risposta troncata per limite di token.`);
  }

  const raw = choice?.message?.content ?? "";
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error: unknown) {
    throw new ModelResponseError(`${model}: JSON non valido.`, { cause: error });
  }
  const result =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? options.parse(data as Record<string, unknown>)
      : null;
  if (result === null) {
    console.warn(`[ai] ${taskName} | ${model} risposta non valida: ${raw.slice(0, 500)}`);
    throw new ModelResponseError(`${model}: risposta non valida o campi mancanti.`);
  }
  return result;
}

/** Combines the metadata of several calls (e.g. text segments) into one summary. */
export function mergeModelInfo(infos: ModelInfo[]): ModelInfo | null {
  if (infos.length === 0) return null;
  return { model: infos[0].model, calls: infos.reduce((total, info) => total + info.calls, 0) };
}

/**
 * Splits text into chunks of at most `maxChars`, preferring paragraph, then sentence,
 * then word boundaries, so each chunk fits comfortably in the model output budget.
 */
export function splitTextIntoSegments(text: string, maxChars = 3000): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const pieces: { text: string; separator: string }[] = [];
  for (const paragraph of trimmed.split(/\n\s*\n/)) {
    const sentences =
      paragraph.length <= maxChars
        ? [paragraph]
        : (paragraph.match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [paragraph]);
    sentences
      .map((sentence) => sentence.trim())
      .filter(Boolean)
      .flatMap((sentence) => (sentence.length <= maxChars ? [sentence] : splitByWords(sentence, maxChars)))
      .forEach((text, index) => pieces.push({ text, separator: index === 0 ? "\n\n" : " " }));
  }

  const segments: string[] = [];
  let current = "";
  for (const { text: piece, separator } of pieces) {
    if (current && current.length + separator.length + piece.length > maxChars) {
      segments.push(current);
      current = piece;
    } else {
      current = current ? current + separator + piece : piece;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function splitByWords(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
