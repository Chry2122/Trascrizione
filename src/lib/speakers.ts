/**
 * Utility per gestire le etichette dei parlanti a inizio riga: "Voce 1: ..." inserite dalla
 * diarizzazione oppure nomi già assegnati ("Sindaco: ...", "Mario Rossi: ...").
 */

import { tokenize, type Token } from "@/lib/transcript-alignment";

/** Prefisso usato per le etichette dei parlanti create dalla diarizzazione. */
export const SPEAKER_LABEL_PREFIX = "Voce";

const TURN_LINE = /^[ \t]*([^\n:]{1,40}?)[ \t]*:[ \t]+(?=\S)/gm;
const DIARIZATION_LABEL = /^Voce \d+$/;
const LABEL_SHAPE = /^\p{L}[\p{L}\p{N}.'’\- ]*$/u;
const MAX_LABEL_WORDS = 4;
// A single short label is accepted only in these cases, so that a sentence such as
// "Il sindaco ha detto: ..." at the start of a line is not taken for a speaker.
const MAX_LONE_LABEL_WORDS = 3;

export type SpeakerTurn = {
  label: string;
  /** Start of the label in the text. */
  start: number;
  /** End of the label itself (before the colon). */
  labelEnd: number;
  /** Start of the spoken content, after "Label: ". */
  contentStart: number;
};

function wordCount(label: string): number {
  return label.split(/\s+/).filter(Boolean).length;
}

/** Speaker turns ("Label: text" at the start of a line), in text order. */
export function findSpeakerTurns(text: string): SpeakerTurn[] {
  if (!text) return [];
  const candidates: SpeakerTurn[] = [];
  for (const match of text.matchAll(TURN_LINE)) {
    const label = match[1].trim().replace(/\s+/g, " ");
    if (!LABEL_SHAPE.test(label) || wordCount(label) > MAX_LABEL_WORDS) continue;
    const start = match.index + match[0].indexOf(match[1]);
    candidates.push({
      label,
      start,
      labelEnd: start + match[1].trimEnd().length,
      contentStart: match.index + match[0].length,
    });
  }

  const counts = new Map<string, number>();
  for (const turn of candidates) counts.set(turn.label, (counts.get(turn.label) ?? 0) + 1);
  const opening = candidates[0]?.start === text.length - text.trimStart().length ? candidates[0] : null;

  return candidates.filter(
    (turn) =>
      DIARIZATION_LABEL.test(turn.label) ||
      (counts.get(turn.label) ?? 0) >= 2 ||
      // A lone label with digits is more likely a heading such as "Ore 12: ...".
      (!/\p{N}/u.test(turn.label) &&
        wordCount(turn.label) <= MAX_LONE_LABEL_WORDS &&
        (counts.size >= 2 || turn === opening)),
  );
}

function labelNumber(label: string): number {
  return DIARIZATION_LABEL.test(label)
    ? Number.parseInt(label.slice(SPEAKER_LABEL_PREFIX.length + 1), 10)
    : Number.POSITIVE_INFINITY;
}

/**
 * Etichette uniche presenti nel testo: prima le "Voce N" in ordine numerico ("Voce 2" prima
 * di "Voce 10"), poi i nomi nell'ordine di apparizione.
 */
export function extractSpeakerLabels(text: string): string[] {
  const unique = Array.from(new Set(findSpeakerTurns(text).map((turn) => turn.label)));
  return unique
    .map((label, order) => ({ label, order }))
    .sort((a, b) => labelNumber(a.label) - labelNumber(b.label) || a.order - b.order)
    .map((item) => item.label);
}

/** Numero di interventi di ciascuna etichetta. */
export function countSpeakerTurns(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { label } of findSpeakerTurns(text)) counts[label] = (counts[label] ?? 0) + 1;
  return counts;
}

/** True se almeno un nome (dopo trim) è non vuoto. */
export function hasSpeakerNames(mapping: Record<string, string>): boolean {
  return Object.values(mapping).some((name) => name.trim().length > 0);
}

/**
 * Sostituisce, solo a inizio intervento, ogni etichetta con il nome associato (trim): la
 * stessa parola nel parlato ("il sindaco ha detto") resta invariata. Le etichette senza nome
 * restano invariate e lo scambio "Voce 1" <-> "Voce 2" funziona perché il testo sostituito non
 * viene rianalizzato.
 */
export function replaceSpeakerLabels(text: string, mapping: Record<string, string>): string {
  if (!text) return text;
  let output = "";
  let cursor = 0;
  for (const turn of findSpeakerTurns(text)) {
    const name = Object.prototype.hasOwnProperty.call(mapping, turn.label)
      ? mapping[turn.label]?.trim().replace(/[\s:]+/g, " ").trim()
      : undefined;
    if (!name) continue;
    output += text.slice(cursor, turn.start) + name;
    cursor = turn.labelEnd;
  }
  return output + text.slice(cursor);
}

/** Character ranges of the labels ("Sindaco: "), which are not spoken words. */
export function speakerLabelRanges(text: string): { start: number; end: number }[] {
  return findSpeakerTurns(text).map((turn) => ({ start: turn.start, end: turn.contentStart }));
}

/** Words of the text without the speaker labels, with their positions in the full text. */
export function tokenizeSpokenWords(text: string): Token[] {
  const ranges = speakerLabelRanges(text);
  let range = 0;
  return tokenize(text).filter((token) => {
    while (range < ranges.length && ranges[range].end <= token.start) range += 1;
    return !(range < ranges.length && token.start >= ranges[range].start);
  });
}

/** The text with the speaker labels removed, for comparisons with the audio. */
export function stripSpeakerLabels(text: string): string {
  let output = "";
  let cursor = 0;
  for (const range of speakerLabelRanges(text)) {
    output += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return output + text.slice(cursor);
}
