import { findSpeakerTurns, tokenizeSpokenWords } from "@/lib/speakers";
import type { ChunkPlan, Silence } from "@/lib/transcription-jobs/audio";
import { diffTokens, tokenize, type Hunk } from "@/lib/transcript-alignment";

const CHUNK_SEPARATOR = "\n\n";

type Interval = { start: number; end: number };

/** Where a chunk's text sits in the joined transcript and when its speech happens. */
export type TimelineSpan = { charStart: number; charEnd: number; speech: Interval[]; speechSec: number };

export type TranscriptTimeline = { text: string; spans: TimelineSpan[] };

function speechIntervals(chunk: ChunkPlan, silences: readonly Silence[]): Interval[] {
  const intervals: Interval[] = [];
  let cursor = chunk.start;
  for (const silence of silences) {
    if (silence.end <= cursor || silence.start >= chunk.end) continue;
    if (silence.start > cursor) intervals.push({ start: cursor, end: silence.start });
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < chunk.end) intervals.push({ start: cursor, end: chunk.end });
  return intervals.length > 0 ? intervals : [{ start: chunk.start, end: chunk.end }];
}

/**
 * Joins the chunk texts into the raw transcript and remembers, for each chunk, its character
 * range and its speech intervals (the chunk minus the detected pauses).
 */
export function buildTimeline(
  chunks: readonly ChunkPlan[],
  texts: readonly string[],
  silences: readonly Silence[] = [],
): TranscriptTimeline {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const spans: TimelineSpan[] = [];
  let text = "";
  chunks.forEach((chunk, index) => {
    const chunkText = (texts[index] ?? "").trim();
    if (!chunkText) return;
    if (text) text += CHUNK_SEPARATOR;
    const speech = speechIntervals(chunk, sorted);
    spans.push({
      charStart: text.length,
      charEnd: text.length + chunkText.length,
      speech,
      speechSec: speech.reduce((total, interval) => total + interval.end - interval.start, 0),
    });
    text += chunkText;
  });
  return { text, spans };
}

/**
 * Estimated audio time of a character of the raw transcript: within its chunk, words are
 * assumed to be spread evenly over the speech, skipping the pauses.
 */
export function timeAtOffset(timeline: TranscriptTimeline, offset: number): number | null {
  const span =
    timeline.spans.find((item) => offset < item.charEnd) ?? timeline.spans.at(-1) ?? null;
  if (!span) return null;
  const ratio = Math.min(1, Math.max(0, (offset - span.charStart) / Math.max(1, span.charEnd - span.charStart)));
  let remaining = ratio * span.speechSec;
  for (const interval of span.speech) {
    const length = interval.end - interval.start;
    if (remaining <= length) return interval.start + remaining;
    remaining -= length;
  }
  return span.speech.at(-1)?.end ?? null;
}

/** Maps a token index of text B to the corresponding token index of text A. */
function mapTokenIndex(hunks: readonly Hunk[], index: number): number {
  let shift = 0;
  for (const hunk of hunks) {
    if (index < hunk.bStart) break;
    if (index < hunk.bEnd) return hunk.aStart;
    shift = hunk.aEnd - hunk.bEnd;
  }
  return index + shift;
}

/**
 * Estimated time (seconds) of the first turn of each speaker ("Voce 1", "Sindaco", ...) in a
 * labeled transcript. Its words are aligned with the timeline text, because the labeled text
 * may differ from it in a few words (fixes, a transcript written by someone else) and always
 * adds the labels and line breaks.
 */
export function firstSpeakerTimes(
  timeline: TranscriptTimeline,
  labeled: string,
): Record<string, number> {
  const firstTurns = new Map<string, number>();
  for (const turn of findSpeakerTurns(labeled)) {
    if (!firstTurns.has(turn.label)) firstTurns.set(turn.label, turn.contentStart);
  }
  if (firstTurns.size === 0) return {};

  const labeledTokens = tokenizeSpokenWords(labeled);
  const rawTokens = tokenize(timeline.text);
  if (rawTokens.length === 0) return {};
  const hunks = diffTokens(
    rawTokens.map((token) => token.norm),
    labeledTokens.map((token) => token.norm),
  );

  const times: Record<string, number> = {};
  for (const [label, contentStart] of firstTurns) {
    const tokenIndex = labeledTokens.findIndex((token) => token.start >= contentStart);
    if (tokenIndex === -1) continue;
    const rawIndex = Math.min(rawTokens.length - 1, mapTokenIndex(hunks, tokenIndex));
    const seconds = timeAtOffset(timeline, rawTokens[rawIndex].start);
    if (seconds !== null) times[label] = Math.round(seconds);
  }
  return times;
}
