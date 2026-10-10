export type Token = { norm: string; start: number; end: number };

/** Half-open token ranges where the two texts differ (an empty range is an insertion). */
export type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number };

// Above this many cells the exact LCS table gets too large; the range is first split on
// words that occur exactly once in both texts (patience diff).
const DP_MAX_CELLS = 4_000_000;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.push({
      norm: match[0].normalize("NFKC").toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export function diffTokens(a: readonly string[], b: readonly string[]): Hunk[] {
  const hunks: Hunk[] = [];
  alignRange(a, b, 0, a.length, 0, b.length, hunks);
  const merged: Hunk[] = [];
  for (const hunk of hunks) {
    const last = merged.at(-1);
    if (last && last.aEnd === hunk.aStart && last.bEnd === hunk.bStart) {
      last.aEnd = hunk.aEnd;
      last.bEnd = hunk.bEnd;
    } else {
      merged.push({ ...hunk });
    }
  }
  return merged;
}

function alignRange(
  a: readonly string[],
  b: readonly string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  out: Hunk[],
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    aLo++;
    bLo++;
  }
  while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  if (aLo === aHi && bLo === bHi) return;
  if (aLo === aHi || bLo === bHi) {
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi });
    return;
  }
  if ((aHi - aLo) * (bHi - bLo) <= DP_MAX_CELLS) {
    lcsAlign(a, b, aLo, aHi, bLo, bHi, out);
    return;
  }

  // Common words repeat everywhere in long speech, so anchors may also be unique sequences
  // of a few consecutive words. The densest set wins: with only a handful of anchors, a
  // single coincidental match could pin the alignment in the wrong place.
  let best: { size: number; anchors: [number, number][] } | null = null;
  for (const size of ANCHOR_SIZES) {
    const anchors = uniqueAnchors(a, b, aLo, aHi, bLo, bHi, size);
    if (anchors.length > (best?.anchors.length ?? 0)) best = { size, anchors };
  }
  if (!best) {
    out.push({ aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bHi });
    return;
  }
  let previousA = aLo;
  let previousB = bLo;
  for (const [indexA, indexB] of best.anchors) {
    if (indexA < previousA || indexB < previousB) continue;
    alignRange(a, b, previousA, indexA, previousB, indexB, out);
    previousA = indexA + best.size;
    previousB = indexB + best.size;
  }
  alignRange(a, b, previousA, aHi, previousB, bHi, out);
}

const ANCHOR_SIZES = [1, 2, 3, 4, 6];

/** Word sequences unique in both ranges, reduced to their longest common increasing sequence. */
function uniqueAnchors(
  a: readonly string[],
  b: readonly string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  size: number,
): [number, number][] {
  const keyAt = (tokens: readonly string[], index: number) =>
    size === 1 ? tokens[index] : tokens.slice(index, index + size).join(" ");
  const counts = new Map<string, { countA: number; countB: number; indexA: number; indexB: number }>();
  for (let i = aLo; i + size <= aHi; i++) {
    const key = keyAt(a, i);
    const entry = counts.get(key) ?? { countA: 0, countB: 0, indexA: -1, indexB: -1 };
    entry.countA++;
    entry.indexA = i;
    counts.set(key, entry);
  }
  for (let j = bLo; j + size <= bHi; j++) {
    const entry = counts.get(keyAt(b, j));
    if (!entry) continue;
    entry.countB++;
    entry.indexB = j;
  }
  const pairs = [...counts.values()]
    .filter((entry) => entry.countA === 1 && entry.countB === 1)
    .map((entry) => [entry.indexA, entry.indexB] as [number, number])
    .sort((x, y) => x[0] - y[0]);

  // Longest increasing subsequence on the b indexes (patience sorting).
  const tails: number[] = [];
  const previous: number[] = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const result: [number, number][] = [];
  for (let k = tails.at(-1) ?? -1; k !== -1; k = previous[k]) result.push(pairs[k]);
  return result.reverse();
}

function lcsAlign(
  a: readonly string[],
  b: readonly string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  out: Hunk[],
): void {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[aLo + i] === b[bLo + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[aLo + i] === b[bLo + j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { aStart: aLo + i, aEnd: aLo + i, bStart: bLo + j, bEnd: bLo + j };
    if (j >= m || (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      i++;
      open.aEnd = aLo + i;
    } else {
      j++;
      open.bEnd = bLo + j;
    }
  }
  close();
}
