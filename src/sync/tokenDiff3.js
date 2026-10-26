/**
 * Word-level three-way merge of one line's lyrics (docs/SYNC-MERGE.md).
 *
 * `tokenize` splits text into words, whitespace runs and single punctuation
 * marks, using explicit character tables (not \s or locale rules) so the
 * Kotlin port splits every string identically. `diff3` lines base/local/remote
 * token arrays up into chunks that are either stable (same on all three) or
 * changed; a changed chunk resolves to whichever side changed it, or is a
 * conflict when both changed it differently.
 *
 * Mirrored by Android's core/domain/.../merge/TokenDiff3.kt -- keep them in
 * step; spec/song-merge.json's tokenizer vectors pin both.
 */

const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

// Each is a token of its own. The apostrophes (' and U+2019) are deliberately
// absent: they stay inside words ("don't", "rock'n'roll").
const PUNCTUATION = new Set(
  [...'!"#$%&()*+,-./:;<=>?@[\\]^_`{|}~'].map((ch) => ch.charCodeAt(0)).concat([
    0x2018, 0x201c, 0x201d, 0x2026, 0x2013, 0x2014, 0xa1, 0xbf, 0xab, 0xbb,
  ]),
);

/** Tokens whose concatenation is exactly `text`. */
export function tokenize(text) {
  const tokens = [];
  let k = 0;
  while (k < text.length) {
    const u = text.charCodeAt(k);
    let end = k + 1;
    if (WHITESPACE.has(u)) {
      while (end < text.length && WHITESPACE.has(text.charCodeAt(end))) end++;
    } else if (!PUNCTUATION.has(u)) {
      while (end < text.length) {
        const v = text.charCodeAt(end);
        if (WHITESPACE.has(v) || PUNCTUATION.has(v)) break;
        end++;
      }
    }
    tokens.push(text.slice(k, end));
    k = end;
  }
  return tokens;
}

/** Above this many LCS cells a line isn't word-merged; it's treated as a clash. */
export const LCS_CELL_BUDGET = 160_000;

/**
 * For each index of `a`, the index of `b` it's matched to by a longest common
 * subsequence (undefined if unmatched), or null if the line is too long to
 * diff within LCS_CELL_BUDGET. Common prefix and suffix are matched first;
 * ties in the LCS walk prefer advancing through `a`, so the result is the
 * same on every platform.
 */
export function matchTokens(a, b) {
  const map = new Array(a.length).fill(undefined);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    map[pre] = pre;
    pre++;
  }
  let suf = 0;
  while (
    suf < a.length - pre && suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    map[a.length - 1 - suf] = b.length - 1 - suf;
    suf++;
  }
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (n === 0 || m === 0) return map;
  if (n * m > LCS_CELL_BUDGET) return null;

  // T[i][j] = LCS length of a[pre+i..] and b[pre+j..] (middle part only).
  const width = m + 1;
  const T = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      T[i * width + j] = a[pre + i] === b[pre + j]
        ? T[(i + 1) * width + j + 1] + 1
        : Math.max(T[(i + 1) * width + j], T[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[pre + i] === b[pre + j]) {
      map[pre + i] = pre + j;
      i++;
      j++;
    } else if (T[(i + 1) * width + j] >= T[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

function sameTokens(x, xs, xe, y, ys, ye) {
  if (xe - xs !== ye - ys) return false;
  for (let k = 0; k < xe - xs; k++) if (x[xs + k] !== y[ys + k]) return false;
  return true;
}

/**
 * Chunks covering base `B`, local `L` and remote `R` (token arrays), in order:
 *   { stable: true,  b: [s, e], l: [s, e], r: [s, e] }
 *   { stable: false, b: [s, e], l: [s, e], r: [s, e], take: 'l' | 'r' | null }
 * `take` says which side's tokens the merge uses for a changed chunk ('l' when
 * both made the same change); null is a conflict. Returns null when the line
 * is over the LCS budget.
 */
export function diff3(B, L, R) {
  const mL = matchTokens(B, L);
  const mR = matchTokens(B, R);
  if (!mL || !mR) return null;

  const chunks = [];
  let iB = 0;
  let iL = 0;
  let iR = 0;
  while (iB < B.length || iL < L.length || iR < R.length) {
    if (iB < B.length && mL[iB] === iL && mR[iB] === iR) {
      let k = iB;
      while (k < B.length && mL[k] === iL + (k - iB) && mR[k] === iR + (k - iB)) k++;
      const len = k - iB;
      chunks.push({ stable: true, b: [iB, k], l: [iL, iL + len], r: [iR, iR + len] });
      iB = k;
      iL += len;
      iR += len;
      continue;
    }
    let k = iB;
    while (k < B.length && (mL[k] === undefined || mR[k] === undefined)) k++;
    const endL = k < B.length ? mL[k] : L.length;
    const endR = k < B.length ? mR[k] : R.length;
    const lSame = sameTokens(L, iL, endL, B, iB, k);
    const rSame = sameTokens(R, iR, endR, B, iB, k);
    let take = null;
    if (lSame) take = 'r';
    else if (rSame) take = 'l';
    else if (sameTokens(L, iL, endL, R, iR, endR)) take = 'l';
    chunks.push({ stable: false, b: [iB, k], l: [iL, endL], r: [iR, endR], take });
    iB = k;
    iL = endL;
    iR = endR;
  }
  return chunks;
}
