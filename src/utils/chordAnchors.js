/**
 * Conversions between a chords row space-padded to align above its lyrics
 * (wire-format v1, the plain-text export, and the editor's chord input) and
 * the wire-format v2 per-chord-anchor shape (`{i, c}`, see
 * `docs/WIRE-FORMAT-v2.md` section 4) that both apps hold songs in. Anchors
 * make a chord's position immune to its own token width changing (e.g. on
 * transpose, `F#` -> `G` doesn't shift every later chord's column) and to
 * how a line is wrapped: a padded string spanning a whole paragraph can't
 * even hold a chord ending one wrapped row next to a chord starting the next
 * without overlapping them.
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

/**
 * `lines` with every `chords` as anchors. Songs saved before the app held
 * chords as anchors -- guest songs in localStorage, and cloud rows written
 * before the v2 conversion -- still have v1's padded string there, and
 * there's no version marker to gate on, so this checks the runtime type.
 */
export function withAnchorChords(lines) {
  return lines.map((l) => (Array.isArray(l.chords) ? l : { ...l, chords: chordsLineToAnchors(l.chords) }));
}
