import type OpenAI from "openai";
import { mergeTierInfo, runTiered, toTierInfo, type TierInfo } from "@/lib/tiered-ai";
import { diffTokens, tokenize, type Hunk, type Token } from "@/lib/transcript-alignment";
import {
  describeDifference,
  isOnlyNumbers,
  isRealError,
  numbersIn,
  type Difference,
} from "@/lib/transcript-compare";
import type { VerifyTranscriptResult } from "@/lib/transcript-verification";

const BATCH_SIZE = 40;
const CONTEXT_TOKENS = 8;
// Below this share of matching words the transcript is not a transcript of this audio:
// classifying thousands of differences would only waste API calls.
const MIN_MATCH_RATIO = 0.5;

const CLASSIFY_INSTRUCTIONS = `Ricevi un elenco di differenze tra una trascrizione fornita dall'utente e la trascrizione automatica (Whisper) dello stesso audio. I due testi sono già stati allineati parola per parola: per ogni differenza ricevi il testo dell'utente ("fornito"), il testo dell'audio ("audio") e qualche parola di contesto.
Classifica OGNI differenza:
- "equivalente" quando le due forme si leggono ad alta voce allo stesso modo o hanno lo stesso significato: numeri in lettere o in cifre ("tre" / "3"), unità di misura per esteso o abbreviate ("chili" / "kg"), apostrofi, varianti ortografiche, parole spezzate o unite diversamente.
- "errore" in tutti gli altri casi: parola diversa, testo omesso dall'utente ("fornito" vuoto), testo in più non pronunciato ("audio" vuoto).
La trascrizione dell'audio è automatica: in caso di dubbio su un singolo suono simile, preferisci "equivalente".
Campi JSON specifici del compito:
- "classificazioni": array con un oggetto { "id": numero, "tipo": "equivalente" | "errore" } per OGNI differenza ricevuta, nessuna esclusa.
- "text": stringa vuota.
- "unclearWords": le differenze per cui non è chiaro se siano un vero errore.`;

type Item = { id: number; hunk: Hunk; fornito: string; audio: string };

function spanOf(text: string, tokens: Token[], start: number, end: number): string {
  return start < end ? text.slice(tokens[start].start, tokens[end - 1].end) : "";
}

function offsetOf(text: string, tokens: Token[], index: number): number {
  return index < tokens.length ? tokens[index].start : text.length;
}

function contextOf(text: string, tokens: Token[], start: number, end: number) {
  const before = spanOf(text, tokens, Math.max(0, start - CONTEXT_TOKENS), start);
  const after = spanOf(text, tokens, end, Math.min(tokens.length, end + CONTEXT_TOKENS));
  return `${before} [...] ${after}`.trim();
}

/** Numbers-only differences are decided without the model; null means "ask the model". */
function decideDeterministically(item: Item): "equivalente" | "errore" | null {
  if (!item.fornito || !item.audio) return null;
  if (!isOnlyNumbers(item.fornito) || !isOnlyNumbers(item.audio)) return null;
  return numbersIn(item.fornito).join(",") === numbersIn(item.audio).join(",")
    ? "equivalente"
    : "errore";
}

function applyCorrections(provided: string, tokens: Token[], errors: Item[]): string {
  let output = "";
  let cursor = 0;
  for (const item of errors) {
    const { aStart, aEnd } = item.hunk;
    let start = offsetOf(provided, tokens, aStart);
    let end = aStart < aEnd ? tokens[aEnd - 1].end : start;
    let replacement = item.audio;
    if (aStart === aEnd) {
      replacement = start < provided.length ? `${item.audio} ` : ` ${item.audio}`;
    } else if (!item.audio && provided[end] === " ") {
      end += 1;
    }
    start = Math.max(start, cursor);
    output += provided.slice(cursor, start) + replacement;
    cursor = Math.max(cursor, end);
  }
  return output + provided.slice(cursor);
}

export class TranscriptMismatchError extends Error {}

export type ComparisonProgress = { done: number; total: number };

/**
 * Verifies transcripts of any length: the texts are aligned word by word without AI, and
 * only the differing passages are classified by the tiered model, in batches.
 */
export async function verifyLongTranscript(options: {
  openai: OpenAI;
  provided: string;
  whisper: string;
  signal: AbortSignal;
  onProgress: (progress: ComparisonProgress) => void;
}): Promise<VerifyTranscriptResult> {
  const { openai, provided, whisper, signal, onProgress } = options;
  const providedTokens = tokenize(provided);
  const whisperTokens = tokenize(whisper);
  const hunks = diffTokens(
    providedTokens.map((token) => token.norm),
    whisperTokens.map((token) => token.norm),
  );

  const changed = hunks.reduce((total, hunk) => total + (hunk.aEnd - hunk.aStart), 0);
  const longest = Math.max(providedTokens.length, whisperTokens.length, 1);
  const matchRatio = (providedTokens.length - changed) / longest;
  if (matchRatio < MIN_MATCH_RATIO) {
    throw new TranscriptMismatchError(
      `La trascrizione non sembra corrispondere a questo audio: coincide solo il ${Math.round(matchRatio * 100)}% delle parole. Controlla di aver caricato il file e il testo giusti.`,
    );
  }

  const items: Item[] = hunks.map((hunk, id) => ({
    id,
    hunk,
    fornito: spanOf(provided, providedTokens, hunk.aStart, hunk.aEnd),
    audio: spanOf(whisper, whisperTokens, hunk.bStart, hunk.bEnd),
  }));
  const verdicts = new Map<number, string>();
  const undecided: Item[] = [];
  for (const item of items) {
    const verdict = decideDeterministically(item);
    if (verdict) verdicts.set(item.id, verdict);
    else undecided.push(item);
  }

  const batches: Item[][] = [];
  for (let i = 0; i < undecided.length; i += BATCH_SIZE) batches.push(undecided.slice(i, i + BATCH_SIZE));
  const tiers: TierInfo[] = [];
  onProgress({ done: 0, total: batches.length });

  for (const [index, batch] of batches.entries()) {
    if (signal.aborted) throw new Error("Operazione annullata.");
    const payload = batch.map((item) => ({
      id: item.id,
      fornito: item.fornito,
      audio: item.audio,
      contestoFornito: contextOf(provided, providedTokens, item.hunk.aStart, item.hunk.aEnd),
      contestoAudio: contextOf(whisper, whisperTokens, item.hunk.bStart, item.hunk.bEnd),
    }));
    const ids = new Set(batch.map((item) => item.id));
    const run = await runTiered<Map<number, string>>({
      client: openai,
      signal,
      taskName: "verify-transcript-long",
      instructions: CLASSIFY_INSTRUCTIONS,
      input: `DIFFERENZE DA CLASSIFICARE:\n${JSON.stringify(payload)}`,
      maxOutputTokens: 4096,
      parseExtra: (record) => {
        if (!Array.isArray(record.classificazioni)) return null;
        const result = new Map<number, string>();
        for (const entry of record.classificazioni as unknown[]) {
          if (typeof entry !== "object" || entry === null) continue;
          const { id, tipo } = entry as { id?: unknown; tipo?: unknown };
          if (typeof id === "number" && ids.has(id) && typeof tipo === "string") result.set(id, tipo);
        }
        return result.size === ids.size ? result : null;
      },
    });
    run.extra.forEach((tipo, id) => verdicts.set(id, tipo));
    tiers.push(toTierInfo(run));
    onProgress({ done: index + 1, total: batches.length });
  }

  const errors = items.filter((item) => {
    const difference: Difference = {
      fornito: item.fornito,
      audio: item.audio,
      tipo: verdicts.get(item.id) ?? "errore",
    };
    return isRealError(difference);
  });
  const tier = mergeTierInfo(tiers);
  if (tier) tier.segments = batches.length;
  if (errors.length === 0) return { isCorrect: true, tier };
  return {
    isCorrect: false,
    errors: errors.map((item) => describeDifference({ ...item, tipo: "errore" })),
    correctedTranscript: applyCorrections(provided, providedTokens, errors),
    tier,
  };
}
