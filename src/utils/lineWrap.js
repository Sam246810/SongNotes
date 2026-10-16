/**
 * Wrapping a song line into display rows. A stored line is a whole paragraph
 * -- the editor wraps it to the screen, and exports wrap it to the page -- so
 * this is the one place that decides which chords go on which row.
 *
 * Ported line-for-line from SongNotes-Android's
 * `core/domain/LineWrap.kt` so both platforms wrap (and therefore export)
 * identically. Lines here are wire-format v2 lines: `{ id, lyrics, chords }`
 * with `chords` as `{ i, c }` anchors (see docs/WIRE-FORMAT-v2.md section 4).
 */

function isLowSurrogate(text, index) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Cuts `lyrics` into rows beginning at `starts` (ascending, first is 0). Each
 * chord goes to the row its index falls in, so it stays above the same lyric
 * character; chords at or past the end of the lyrics (an ending chord, or a
 * chords-only line) stay on the last row. Row chords are row-relative.
 *
 * @returns {Array<{ lyrics: string, chords: Array<{ i: number, c: string }> }>}
 */
export function cutIntoRows(lyrics, chords, starts) {
  const last = starts.length - 1;
  return starts.map((start, k) => {
    const end = k < last ? starts[k + 1] : lyrics.length;
    const rowChords = chords
      .filter((a) => a.i >= start && (k === last || a.i < end))
      .map((a) => ({ ...a, i: a.i - start }));
    return { lyrics: lyrics.slice(start, end), chords: rowChords };
  });
}

/**
 * Row start offsets for `text` wrapped at `maxColumns` monospace columns,
 * with the same greedy rule a text editor applies on screen: a word that
 * doesn't fit moves down whole, the spaces before it hang at the end of the
 * row above (so the next row starts flush), and a run with no space in it is
 * cut at the last character that fits.
 */
export function columnBreaks(text, maxColumns) {
  const starts = [0];
  if (maxColumns <= 0) return starts;
  let pos = 0;
  while (text.length - pos > maxColumns) {
    const limit = pos + maxColumns;
    let end;
    if (text[limit] === ' ') {
      end = limit;
    } else {
      const space = text.lastIndexOf(' ', limit - 1);
      end = space > pos ? space + 1 : limit;
    }
    while (end < text.length && text[end] === ' ') end++;
    if (end < text.length && isLowSurrogate(text, end) && end - 1 > pos) end--;
    if (end >= text.length) break;
    pos = end;
    starts.push(pos);
  }
  return starts;
}

/**
 * `song` with every line wrapped to `maxColumns` for a fixed-width export
 * (plain text, print): each row becomes its own line, with the spaces a wrap
 * hung at its end trimmed. Chords that sit past the end of a short last row
 * and would run beyond `maxColumns` continue on a chords-only row of their
 * own rather than off the page.
 */
export function wrapSongToColumns(song, maxColumns) {
  const lines = song.lines.flatMap((line) => {
    const sorted = [...line.chords].sort((a, b) => a.i - b.i);
    const rows = cutIntoRows(line.lyrics, sorted, columnBreaks(line.lyrics, maxColumns));
    const out = rows.slice(0, -1).map((row) => ({ id: line.id, lyrics: row.lyrics.trimEnd(), chords: row.chords }));
    const lastRow = rows[rows.length - 1];
    let last = { lyrics: lastRow.lyrics.trimEnd(), chords: lastRow.chords };
    for (;;) {
      const overflow = last.chords.findIndex(
        (a) => a.i > 0 && a.i + a.c.length > maxColumns && a.i >= last.lyrics.length,
      );
      if (overflow <= 0) break;
      out.push({ id: line.id, lyrics: last.lyrics, chords: last.chords.slice(0, overflow) });
      const shift = last.chords[overflow].i;
      last = { lyrics: '', chords: last.chords.slice(overflow).map((a) => ({ ...a, i: a.i - shift })) };
    }
    out.push({ id: line.id, lyrics: last.lyrics, chords: last.chords });
    return out;
  });
  return { ...song, lines };
}
