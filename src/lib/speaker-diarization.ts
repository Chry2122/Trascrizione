import type OpenAI from "openai";
import {
  DIARIZATION_MODEL,
  mergeModelInfo,
  ModelResponseError,
  runJsonTask,
  splitTextIntoSegments,
  type ModelInfo,
} from "@/lib/ai-model";
import { diffTokens, tokenize } from "@/lib/transcript-alignment";

const SEGMENT_MAX_CHARS = 3000;
const SEGMENT_MAX_OUTPUT_TOKENS = 4096;
// Up to this length the whole transcript is labeled with one call; the labeled copy must
// still fit within gpt-4o-mini's 16k output tokens.
const SINGLE_PASS_MAX_CHARS = 36_000;
const SINGLE_PASS_MAX_OUTPUT_TOKENS = 16_000;
const CONTEXT_CHARS = 800;
// Labelling may fix a few misheard words, but a larger share of changed words means the
// model rewrote the text, so that segment keeps the Whisper text instead.
const MAX_CHANGED_RATIO = 0.08;
const LABEL_PREFIX = /^\s*\**\s*Voce\s+(\d+)\s*\**\s*:\s*\**\s*/i;

const INSTRUCTIONS = `Ricevi un segmento della trascrizione automatica (Whisper) di una registrazione, senza alcuna indicazione su chi parla. Il tuo compito è dividere il testo negli interventi dei diversi parlanti e indicare chi parla.
Regole obbligatorie:
- Ogni intervento va su una riga a sé che inizia con l'etichetta del parlante seguita da due punti: "Voce 1: ...", "Voce 2: ...". Usa solo etichette nel formato "Voce N".
- NON riassumere, NON riformulare, NON tradurre, NON omettere e NON aggiungere parole. Puoi correggere solo parole evidentemente trascritte male dal riconoscimento vocale. Mantieni la punteggiatura.
- Non hai l'audio: deduci i cambi di voce dal contenuto (domande e risposte, nomi o vocativi, cambi di punto di vista, risposte brevi come "sì", "esatto", "certo"). Se è un monologo usa solo "Voce 1".
- Se ricevi i parlanti già individuati nei segmenti precedenti, usa la stessa etichetta per la stessa persona e assegna un numero nuovo solo a persone nuove. Il segmento può iniziare a metà dell'intervento dell'ultimo parlante del segmento precedente.
Rispondi ESCLUSIVAMENTE con un oggetto JSON valido con questi campi:
- "text": il segmento completo con le etichette, un intervento per riga.
- "parlanti": array di oggetti { "etichetta": "Voce N", "descrizione": "..." } con TUTTI i parlanti individuati finora (anche quelli dei segmenti precedenti), dove "descrizione" è una frase breve su chi è (ruolo, nome se viene detto, di cosa parla).`;

export type Speaker = { label: string; description: string };

/** What the next segment needs to keep the speaker numbering consistent. */
export type DiarizationState = { speakers: Speaker[]; tail: string };

export type DiarizedSegment = {
  text: string;
  labeled: boolean;
  ai: ModelInfo | null;
  state: DiarizationState;
};

export const INITIAL_DIARIZATION_STATE: DiarizationState = { speakers: [], tail: "" };

export function splitForDiarization(text: string): string[] {
  return splitTextIntoSegments(text, SEGMENT_MAX_CHARS);
}

function stripLabels(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(LABEL_PREFIX, ""))
    .join("\n");
}

/** Returns the text with canonical "Voce N: " prefixes, or null if a turn has no label. */
function normalizeLabeledText(text: string): string | null {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const normalized: string[] = [];
  for (const line of lines) {
    const match = LABEL_PREFIX.exec(line);
    const content = match ? line.slice(match[0].length).trim() : "";
    if (!match || !content) return null;
    normalized.push(`Voce ${Number(match[1])}: ${content}`);
  }
  return normalized.join("\n");
}

function changedRatio(original: string, labeled: string): number {
  const before = tokenize(original).map((token) => token.norm);
  const after = tokenize(stripLabels(labeled)).map((token) => token.norm);
  const changed = diffTokens(before, after).reduce(
    (total, hunk) => total + Math.max(hunk.aEnd - hunk.aStart, hunk.bEnd - hunk.bStart),
    0,
  );
  return changed / Math.max(before.length, 1);
}

function readSpeakers(value: unknown): Speaker[] | null {
  if (!Array.isArray(value)) return null;
  const speakers: Speaker[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const { etichetta, descrizione } = item as { etichetta?: unknown; descrizione?: unknown };
    const match = typeof etichetta === "string" ? /Voce\s+(\d+)/i.exec(etichetta) : null;
    if (!match) continue;
    speakers.push({
      label: `Voce ${Number(match[1])}`,
      description: typeof descrizione === "string" ? descrizione.trim().slice(0, 200) : "",
    });
  }
  return speakers;
}

function buildInput(segment: string, state: DiarizationState): string {
  const known =
    state.speakers.length > 0
      ? state.speakers.map((speaker) => `- ${speaker.label}: ${speaker.description || "(nessuna descrizione)"}`).join("\n")
      : "(nessuno: questo è l'inizio della registrazione)";
  return [
    "PARLANTI GIÀ INDIVIDUATI:",
    known,
    "",
    ...(state.tail ? ["FINE DEL SEGMENTO PRECEDENTE (solo contesto, non va ripetuta):", "<<<", state.tail, ">>>", ""] : []),
    "SEGMENTO DA ELABORARE:",
    "<<<",
    segment,
    ">>>",
  ].join("\n");
}

/**
 * Labels the speaker turns of one segment with a single gpt-4o-mini call. If the answer is
 * unusable the Whisper text is kept unlabeled, so a transcript is never lost.
 */
export async function diarizeSegment(
  openai: OpenAI,
  segment: string,
  state: DiarizationState,
  signal: AbortSignal,
  maxOutputTokens = SEGMENT_MAX_OUTPUT_TOKENS,
): Promise<DiarizedSegment> {
  try {
    const { text, speakers } = await runJsonTask({
      client: openai,
      model: DIARIZATION_MODEL,
      signal,
      taskName: "diarization",
      instructions: INSTRUCTIONS,
      input: buildInput(segment, state),
      maxOutputTokens,
      parse: (record) => {
        const text = typeof record.text === "string" ? normalizeLabeledText(record.text) : null;
        if (!text || changedRatio(segment, text) > MAX_CHANGED_RATIO) return null;
        return { text, speakers: readSpeakers(record.parlanti) ?? state.speakers };
      },
    });
    return {
      text,
      labeled: true,
      ai: { model: DIARIZATION_MODEL, calls: 1 },
      state: {
        speakers: speakers.length > 0 ? speakers : state.speakers,
        tail: text.slice(-CONTEXT_CHARS),
      },
    };
  } catch (error: unknown) {
    if (!(error instanceof ModelResponseError) || signal.aborted) throw error;
    console.warn(`[diarization] segmento lasciato senza etichette: ${error.message}`);
    return { text: segment, labeled: false, ai: null, state: { ...state, tail: "" } };
  }
}

/** Joins labeled segments, merging a turn split across two segments into one line. */
export function joinDiarizedSegments(segments: Pick<DiarizedSegment, "text" | "labeled">[]): string {
  let output = "";
  let lastLabel: string | null = null;
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    if (!segment.labeled) {
      output += `${output ? "\n\n" : ""}${text}`;
      lastLabel = null;
      continue;
    }
    const lines = text.split("\n");
    const firstLabel = /^Voce \d+(?=:)/.exec(lines[0])?.[0] ?? null;
    if (output && firstLabel && firstLabel === lastLabel) {
      output += ` ${lines[0].slice(firstLabel.length + 1).trim()}`;
      lines.shift();
    }
    if (lines.length > 0) output += `${output ? "\n" : ""}${lines.join("\n")}`;
    lastLabel = /^Voce \d+(?=:)/.exec(lines.at(-1) ?? "")?.[0] ?? lastLabel;
  }
  return output;
}

/**
 * Labels a whole transcript with a single gpt-4o-mini call. Only texts too long for one
 * answer are labeled segment after segment, keeping the numbering consistent.
 */
export async function diarizeTranscript(
  openai: OpenAI,
  text: string,
  signal: AbortSignal,
): Promise<{ text: string; ai: ModelInfo | null; unlabeledSegments: number }> {
  const trimmed = text.trim();
  if (trimmed.length <= SINGLE_PASS_MAX_CHARS) {
    const result = await diarizeSegment(
      openai,
      trimmed,
      INITIAL_DIARIZATION_STATE,
      signal,
      SINGLE_PASS_MAX_OUTPUT_TOKENS,
    );
    return { text: result.text, ai: result.ai, unlabeledSegments: result.labeled ? 0 : 1 };
  }

  const results: DiarizedSegment[] = [];
  let state = INITIAL_DIARIZATION_STATE;
  for (const segment of splitForDiarization(trimmed)) {
    if (signal.aborted) throw new Error("Operazione annullata.");
    const result = await diarizeSegment(openai, segment, state, signal);
    results.push(result);
    state = result.state;
  }
  return {
    text: joinDiarizedSegments(results),
    ai: mergeModelInfo(results.flatMap((result) => (result.ai ? [result.ai] : []))),
    unlabeledSegments: results.filter((result) => !result.labeled).length,
  };
}
