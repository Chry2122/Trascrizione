import OpenAI, { AuthenticationError, RateLimitError } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

export type Tier = "low" | "medium" | "high";

// Only the cheapest model is used: no automatic escalation to gpt-4o / o3-mini.
export const TIER_ORDER: readonly Tier[] = ["low"];

export const TIER_MODELS: Record<Tier, string> = {
  low: "gpt-4o-mini",
  medium: "gpt-4o",
  high: "o3-mini",
};

export const HIGH_TIER_REASONING_EFFORT = "high" as const;

export type TierThresholds = {
  /** Minimum confidence for the low tier result to be accepted. */
  low: number;
  /** Minimum confidence for the medium tier result to be accepted. */
  medium: number;
};

export const DEFAULT_THRESHOLDS: TierThresholds = { low: 85, medium: 75 };

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** Reasoning tokens count against `max_completion_tokens` on o-series models. */
const REASONING_TOKEN_BUDGET = 12_000;
const MAX_UNCLEAR_WORDS = 50;

export type TieredBaseOutput = {
  text: string;
  confidenceScore: number;
  unclearWords: string[];
  needsEscalation: boolean;
};

export type TierAttempt = {
  tier: Tier;
  model: string;
  /** null when the call failed or the response was not valid JSON. */
  confidenceScore: number | null;
  unclearWords: string[];
  needsEscalation: boolean;
  accepted: boolean;
  /** Why the next tier was tried (or why this attempt was discarded). */
  escalationReason?: string;
  durationMs: number;
};

/** Serializable tier metadata exposed to API clients. */
export type TierInfo = {
  tierUsed: Tier;
  model: string;
  confidenceScore: number;
  unclearWords: string[];
  attempts: TierAttempt[];
  /** Number of segments processed, when a text was split into several tiered runs. */
  segments?: number;
};

export type TieredRunOptions<T> = {
  client: OpenAI;
  /** Short label used in logs, e.g. "verify-transcript". */
  taskName: string;
  /**
   * Task-specific instructions (Italian). They must describe any extra JSON fields the
   * task needs; the base fields contract is appended automatically.
   */
  instructions: string;
  /** User content to process. */
  input: string;
  /**
   * Validates and extracts the task-specific fields. Returning null marks the response
   * as invalid, which triggers an escalation to the next tier.
   */
  parseExtra?: (record: Record<string, unknown>, base: TieredBaseOutput) => T | null;
  /**
   * Task-specific deterministic doubt signals, merged into `unclearWords` before the
   * escalation decision. Useful because cheaper models tend to overstate their confidence.
   */
  deriveUnclearWords?: (extra: T, base: TieredBaseOutput, tier: Tier) => string[];
  thresholds?: Partial<TierThresholds>;
  maxOutputTokens?: number;
  /** Aborts the pending call and prevents any further tier (e.g. the client disconnected). */
  signal?: AbortSignal;
};

export type TieredRunResult<T> = TierInfo & {
  result: TieredBaseOutput;
  extra: T;
};

export class TieredAIError extends Error {
  readonly attempts: TierAttempt[];

  constructor(message: string, attempts: TierAttempt[], cause?: unknown) {
    super(message, { cause });
    this.name = "TieredAIError";
    this.attempts = attempts;
  }
}

const BASE_CONTRACT = `Rispondi ESCLUSIVAMENTE con un oggetto JSON valido che, oltre agli eventuali campi richiesti sopra, contenga SEMPRE questi campi:
- "text": stringa, il testo risultante/corretto del compito.
- "confidenceScore": numero intero da 0 a 100 che indica quanto sei sicuro del risultato (100 = certezza assoluta).
- "unclearWords": array di stringhe con le parole o espressioni del testo di cui non sei sicuro (ambigue, probabilmente fraintese, incomprensibili). Array vuoto se non ce ne sono.
- "needsEscalation": booleano, true se il caso è troppo ambiguo o complesso per essere risolto con sicurezza e servirebbe un'analisi più approfondita.
Valuta la sicurezza in modo onesto e calibrato, senza sovrastimarla:
- 90-100: nessun dubbio, ogni scelta è confermata in modo evidente dal contesto.
- 70-89: almeno un punto è stato risolto per ipotesi plausibile ma non certa.
- sotto 70: ambiguità rilevanti o parole che non riesci a interpretare.
Ogni parola che hai interpretato o corretto per ipotesi (senza un indizio chiaro nel contesto) o che non riesci a interpretare DEVE comparire in "unclearWords".`;

const MEDIUM_PREAMBLE = `Sei il secondo livello di revisione. Un modello precedente ha svolto lo stesso compito ma ha segnalato incertezza. Riceverai il suo risultato e l'elenco delle parole dubbie: usa il contesto dell'intero testo per risolverle, correggi gli errori del risultato precedente e rivaluta con attenzione la tua sicurezza.`;

const HIGH_PREAMBLE = `Sei il livello finale di revisione ad alta precisione, usato solo per i casi più ambigui o complessi. I livelli precedenti non sono riusciti a raggiungere una sicurezza sufficiente. Analizza il testo con la massima accuratezza, considera più interpretazioni possibili per ogni punto dubbio, verifica la coerenza con il contesto e scegli quella più plausibile. Non inventare contenuti che non sono presenti nell'input.`;

function buildSystemPrompt(tier: Tier, instructions: string): string {
  const preamble = tier === "medium" ? MEDIUM_PREAMBLE : tier === "high" ? HIGH_PREAMBLE : "";
  return [preamble, instructions.trim(), BASE_CONTRACT].filter(Boolean).join("\n\n");
}

function buildUserPrompt(input: string, previous: PreviousOutput | null): string {
  if (!previous) return input;
  const words = previous.unclearWords.length > 0 ? previous.unclearWords.join(", ") : "(nessuna)";
  return [
    input,
    "",
    `RISULTATO DEL LIVELLO PRECEDENTE (${previous.model}, sicurezza ${previous.confidenceScore ?? "n/d"}/100):`,
    "<<<",
    previous.raw,
    ">>>",
    "",
    `PAROLE DUBBIE SEGNALATE: ${words}`,
  ].join("\n");
}

type PreviousOutput = {
  model: string;
  raw: string;
  confidenceScore: number | null;
  unclearWords: string[];
};

function clampScore(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  return Math.round(Math.min(100, Math.max(0, number)));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const words = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(words)).slice(0, MAX_UNCLEAR_WORDS);
}

function parseBase(raw: string): { record: Record<string, unknown>; base: TieredBaseOutput } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const confidenceScore = clampScore(record.confidenceScore);
  if (typeof record.text !== "string" || confidenceScore === null) return null;
  return {
    record,
    base: {
      text: record.text,
      confidenceScore,
      unclearWords: readStringArray(record.unclearWords),
      needsEscalation: record.needsEscalation === true || record.needsEscalation === "true",
    },
  };
}

function isFatalApiError(error: unknown): boolean {
  return error instanceof AuthenticationError || error instanceof RateLimitError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReasoningModel(model: string): boolean {
  return /^o\d/.test(model);
}

async function callModel(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const params: ChatCompletionCreateParamsNonStreaming = {
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (isReasoningModel(model)) {
    params.reasoning_effort = HIGH_TIER_REASONING_EFFORT;
    params.max_completion_tokens = maxOutputTokens + REASONING_TOKEN_BUDGET;
  } else {
    params.temperature = 0;
    params.max_completion_tokens = maxOutputTokens;
  }
  const completion = await client.chat.completions.create(params, { signal, maxRetries: 0 });
  const choice = completion.choices[0];
  if (choice?.finish_reason === "length") {
    throw new TruncatedOutputError();
  }
  return choice?.message?.content ?? "";
}

class TruncatedOutputError extends Error {
  constructor() {
    super("risposta troncata per limite di token");
  }
}

function log(taskName: string, attempt: TierAttempt) {
  const parts = [
    `[tiered-ai] ${taskName}`,
    `tier=${attempt.tier}`,
    `model=${attempt.model}`,
    `score=${attempt.confidenceScore ?? "n/d"}`,
    `unclear=${attempt.unclearWords.length}`,
    `needsEscalation=${attempt.needsEscalation}`,
    `${attempt.durationMs}ms`,
    attempt.accepted ? "ACCETTATO" : `escalation: ${attempt.escalationReason ?? "-"}`,
  ];
  console.log(parts.join(" | "));
}

function escalationReasonFor(
  tier: Tier,
  base: TieredBaseOutput,
  thresholds: TierThresholds,
): string | null {
  if (tier === "low") {
    const reasons: string[] = [];
    if (base.confidenceScore < thresholds.low) reasons.push(`score ${base.confidenceScore} < ${thresholds.low}`);
    if (base.needsEscalation) reasons.push("needsEscalation");
    if (base.unclearWords.length > 0) reasons.push(`${base.unclearWords.length} parole dubbie`);
    return reasons.length > 0 ? reasons.join(", ") : null;
  }
  if (tier === "medium") {
    const reasons: string[] = [];
    if (base.confidenceScore < thresholds.medium) {
      reasons.push(`score ${base.confidenceScore} < ${thresholds.medium}`);
    }
    if (base.needsEscalation) reasons.push("needsEscalation");
    return reasons.length > 0 ? reasons.join(", ") : null;
  }
  return null;
}

type ValidOutcome<T> = {
  tier: Tier;
  model: string;
  base: TieredBaseOutput;
  extra: T;
};

/**
 * Runs a JSON task on the cheapest tier first and escalates (low → medium → high) only
 * when the model reports low confidence, unclear words, an explicit escalation request,
 * or returns an invalid response. Authentication and rate limit errors are rethrown.
 */
export async function runTiered<T = Record<string, never>>(
  options: TieredRunOptions<T>,
): Promise<TieredRunResult<T>> {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const parseExtra = options.parseExtra ?? (() => ({}) as T);

  const attempts: TierAttempt[] = [];
  const valid: ValidOutcome<T>[] = [];
  let previous: PreviousOutput | null = null;
  let lastError: unknown;

  const finish = (outcome: ValidOutcome<T>): TieredRunResult<T> => ({
    tierUsed: outcome.tier,
    model: outcome.model,
    confidenceScore: outcome.base.confidenceScore,
    unclearWords: outcome.base.unclearWords,
    attempts,
    result: outcome.base,
    extra: outcome.extra,
  });

  // At most one call per tier (3 in total): no retries, no extra fallback calls.
  for (const tier of TIER_ORDER) {
    if (options.signal?.aborted) throw new TieredAIError("Elaborazione annullata.", attempts);
    const system = buildSystemPrompt(tier, options.instructions);
    const user = buildUserPrompt(options.input, previous);
    const model = TIER_MODELS[tier];
    const startedAt = Date.now();

    let raw: string | null = null;
    let failure: string | null = null;
    try {
      raw = await callModel(options.client, model, system, user, maxOutputTokens, options.signal);
    } catch (error: unknown) {
      if (isFatalApiError(error) || options.signal?.aborted) throw error;
      lastError = error;
      failure = `errore API: ${errorMessage(error)}`;
    }

    const parsed = raw !== null ? parseBase(raw) : null;
    const extra = parsed ? parseExtra(parsed.record, parsed.base) : null;
    if (parsed && extra !== null && options.deriveUnclearWords) {
      parsed.base.unclearWords = readStringArray([
        ...parsed.base.unclearWords,
        ...options.deriveUnclearWords(extra, parsed.base, tier),
      ]);
    }
    if (raw !== null && (!parsed || extra === null)) {
      failure = "JSON non valido o campi mancanti";
      console.warn(`[tiered-ai] ${options.taskName} | ${model} risposta non valida: ${raw.slice(0, 500)}`);
    }

    const attempt: TierAttempt = {
      tier,
      model,
      confidenceScore: parsed?.base.confidenceScore ?? null,
      unclearWords: parsed?.base.unclearWords ?? [],
      needsEscalation: parsed?.base.needsEscalation ?? false,
      accepted: false,
      durationMs: Date.now() - startedAt,
    };
    attempts.push(attempt);

    if (failure || !parsed || extra === null) {
      attempt.escalationReason = failure ?? "risposta non valida";
      log(options.taskName, attempt);
      continue;
    }

    const outcome: ValidOutcome<T> = { tier, model, base: parsed.base, extra };
    valid.push(outcome);
    const reason = escalationReasonFor(tier, parsed.base, thresholds);
    if (!reason) {
      attempt.accepted = true;
      log(options.taskName, attempt);
      return finish(outcome);
    }

    attempt.escalationReason = reason;
    log(options.taskName, attempt);
    previous = {
      model,
      raw: raw ?? "",
      confidenceScore: parsed.base.confidenceScore,
      unclearWords: parsed.base.unclearWords,
    };
  }

  // The high tier is the last resort: if it failed, keep the most confident valid result.
  const best = valid.reduce<ValidOutcome<T> | null>(
    (current, item) =>
      !current || item.base.confidenceScore >= current.base.confidenceScore ? item : current,
    null,
  );
  if (best) {
    const attempt = attempts.find((item) => item.tier === best.tier && item.model === best.model);
    if (attempt) attempt.accepted = true;
    console.log(
      `[tiered-ai] ${options.taskName} | nessun livello pienamente sicuro, uso tier=${best.tier} (${best.model}, score ${best.base.confidenceScore})`,
    );
    return finish(best);
  }

  throw new TieredAIError(
    "Nessun livello del modello ha restituito una risposta valida.",
    attempts,
    lastError,
  );
}

const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2 };

/** Combines the metadata of several tiered runs (e.g. text segments) into one summary. */
export function mergeTierInfo(infos: TierInfo[]): TierInfo | null {
  if (infos.length === 0) return null;
  const highest = infos.reduce((current, item) =>
    TIER_RANK[item.tierUsed] > TIER_RANK[current.tierUsed] ? item : current,
  );
  return {
    tierUsed: highest.tierUsed,
    model: highest.model,
    confidenceScore: Math.min(...infos.map((item) => item.confidenceScore)),
    unclearWords: Array.from(new Set(infos.flatMap((item) => item.unclearWords))).slice(
      0,
      MAX_UNCLEAR_WORDS,
    ),
    attempts: infos.flatMap((item) => item.attempts),
    segments: infos.reduce((total, item) => total + (item.segments ?? 1), 0),
  };
}

/** Strips the internal result fields, leaving only what is safe to send to clients. */
export function toTierInfo(run: TierInfo): TierInfo {
  const info: TierInfo = {
    tierUsed: run.tierUsed,
    model: run.model,
    confidenceScore: run.confidenceScore,
    unclearWords: run.unclearWords,
    attempts: run.attempts,
  };
  if (run.segments !== undefined) info.segments = run.segments;
  return info;
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
