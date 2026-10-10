export type Difference = { fornito: string; audio: string; tipo: string };

export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, un: 1, uno: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7,
  otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14,
  quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19, venti: 20,
  trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80,
  novanta: 90, cento: 100, mille: 1000,
};

function numberValue(token: string): number | undefined {
  return /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
}

export function numbersIn(text: string): number[] {
  return normalizeForComparison(text)
    .split(" ")
    .map(numberValue)
    .filter((value): value is number => value !== undefined);
}

/** True when the text is made only of numbers (in digits or Italian words). */
export function isOnlyNumbers(text: string): boolean {
  const tokens = normalizeForComparison(text).split(" ").filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => numberValue(token) !== undefined);
}

// gpt-4o-mini is inconsistent on punctuation-only and number differences, so those are
// decided here deterministically; everything else keeps the model's classification.
export function isRealError(difference: Difference): boolean {
  if (normalizeForComparison(difference.fornito) === normalizeForComparison(difference.audio)) {
    return false;
  }
  const provided = numbersIn(difference.fornito);
  const spoken = numbersIn(difference.audio);
  if (provided.length > 0 && spoken.length > 0) {
    return provided.join(",") !== spoken.join(",") || difference.tipo === "errore";
  }
  return difference.tipo === "errore";
}

export function describeDifference({ fornito, audio }: Difference): string {
  if (!fornito) return `Testo omesso: nell'audio è stato detto "${audio}".`;
  if (!audio) return `"${fornito}" non è presente nell'audio.`;
  return `"${fornito}" non corrisponde all'audio: è stato detto "${audio}".`;
}
