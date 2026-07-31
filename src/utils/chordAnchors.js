/**
 * Conversions between this app's own internal editor model (a chords row
 * space-padded to align above its lyrics row) and the wire-format v2
 * per-chord-anchor shape (`{i, c}`) that `songs.content` is actually stored
 * as (see `docs/WIRE-FORMAT-v2.md` section 4) -- the same model the Android
 * app's editor natively uses, and what makes a chord's stored position immune
 * to that chord's own token width changing (e.g. on transpose, `F#` -> `G`
 * no longer needs to shift every subsequent chord's column, because position
 * was never encoded as a column in storage, only in the padded-string
 * *editing* representation).
 *
 * Ported line-for-line from SongNotes-Android's own
 * `core/domain/ChordAnchors.kt` (written directly from the wire-format spec,
 * no earlier JS version existed) so both platforms agree exactly, including
 * the mandated overlap-resolution rule in `anchorsToChordsLine`.
 */

/** Scans `chordsLine` for maximal non-whitespace runs; each run's start column becomes `i`, its text becomes `c`. */
export function chordsLineToAnchors(chordsLine) {
  if (!chordsLine) return [];
  const anchors = [];
  let i = 0;
  while (i < chordsLine.length) {
    if (/\s/.test(chordsLine[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < chordsLine.length && !/\s/.test(chordsLine[i])) i++;
    anchors.push({ i: start, c: chordsLine.slice(start, i) });
  }
  return anchors;
}

/**
 * Renders `chords` back into a space-padded string at least `lyricsLength`
 * characters long (longer if any anchor's rendered span extends past it).
 * Overlapping columns are resolved by later-anchor-in-sort-order wins --
 * both platforms must agree on this, since plain-text export has no way to
 * represent two chords at the same column.
 */
export function anchorsToChordsLine(lyricsLength, chords) {
  if (!chords || chords.length === 0) return ' '.repeat(Math.max(0, lyricsLength));
  const sorted = [...chords].sort((a, b) => a.i - b.i); // stable in all modern JS engines
  const totalLength = Math.max(lyricsLength, ...sorted.map((a) => a.i + a.c.length));
  const chars = new Array(totalLength).fill(' ');
  for (const anchor of sorted) {
    for (let j = 0; j < anchor.c.length; j++) {
      const pos = anchor.i + j;
      if (pos >= 0 && pos < chars.length) chars[pos] = anchor.c[j];
    }
  }
  return chars.join('');
}
