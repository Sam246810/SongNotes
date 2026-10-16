/**
 * The editor's paragraph model, kept free of React so it can be tested on its
 * own. Ported from SongNotes-Android's `SongEditorScreen.kt`, which was
 * checked side by side against Samsung Notes.
 *
 * A song line (`{ id, lyrics, chords: [{ i, c }] }`) is a paragraph: a real
 * line the user made with Enter, however long. The editor draws it as rows
 * that soft-wrap to the screen width (see `rowStarts`). Wrapping is only how
 * a paragraph is drawn, never part of its text, so every edit here works on
 * whole paragraphs and lets the rows be cut again from the result. Chords
 * travel as anchors at paragraph-wide character offsets, so each one stays
 * above the same lyric character however its paragraph is re-wrapped.
 */
import { v4 as uuidv4 } from 'uuid';
import { chordsLineToAnchors } from './chordAnchors';
import { columnBreaks, cutIntoRows } from './lineWrap';

const byIndex = (a, b) => a.i - b.i;

function isHighSurrogate(text, index) {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(text, index) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Start offsets of the rows a paragraph's `text` wraps into at `columns`, per
 * `columnBreaks`. Spaces hanging at the end of a row are never counted, so a
 * word that exactly fills its row stays there after you type the space after
 * it. With `caretAtEnd` (the caret sits after those hanging spaces, at the
 * very end of the paragraph) the caret gets a fresh empty row of its own, as
 * in any text editor: not parked at the edge until the next letter arrives,
 * and not whisked up a row when the word after the space is backspaced. Only
 * while the caret is there; anywhere else it would just be a blank row in
 * the song.
 */
export function rowStarts(text, columns, caretAtEnd = false) {
  const starts = columnBreaks(text, columns);
  const lastRowLength = text.length - starts[starts.length - 1];
  if (caretAtEnd && columns > 0 && lastRowLength > columns && text.endsWith(' ')) starts.push(text.length);
  return starts;
}

/**
 * The row a paragraph offset falls on. An offset exactly on a row boundary
 * belongs to the start of the next row, which is where a text editor draws
 * the caret too.
 */
export function rowOfOffset(starts, offset) {
  let k = 0;
  while (k + 1 < starts.length && starts[k + 1] <= offset) k++;
  return k;
}

/**
 * Renders row-relative chord anchors as a chords-track string, padded with
 * spaces to `padTo`. Unlike the wire format's `anchorsToChordsLine` -- where a
 * later anchor overwrites an earlier one at a shared column -- an anchor that
 * would collide with the one before it is nudged right: an editor must never
 * fuse two chord names into one ("Am" + "G" -> "AG"). Collisions only arise
 * when re-wrapping a paragraph lands chords from two different rows on one.
 */
export function renderChordAnchors(anchors, padTo) {
  let out = '';
  for (const anchor of [...anchors].sort(byIndex)) {
    const start = out.length === 0 ? anchor.i : Math.max(anchor.i, out.length + 1);
    out = out.padEnd(start) + anchor.c;
  }
  return out.padEnd(padTo);
}

/**
 * A paragraph drawn as rows: each row's lyrics, its chords-track string
 * (padded no wider than `columns`), and where it starts in the paragraph.
 */
export function layoutParagraph(line, starts, columns) {
  const sorted = [...line.chords].sort(byIndex);
  return cutIntoRows(line.lyrics, sorted, starts).map((row, k) => ({
    start: starts[k],
    lyrics: row.lyrics,
    chords: renderChordAnchors(row.chords, Math.min(row.lyrics.length, columns)),
  }));
}

/**
 * A paragraph's chords after row `k` (cut at `starts`) was edited to
 * `rowChordsText`. A chord typed out past the end of a row's lyrics -- in the
 * empty space a wrap leaves at the end of every row but the last -- has no
 * paragraph offset of its own (that offset is the start of the next row), so
 * it's pinned to the row's last character instead, the space the wrap hung
 * there. On the last row a chord past the lyrics keeps its column: an ending
 * chord, or a chords-only line.
 */
export function replaceRowChords(line, starts, k, rowChordsText) {
  const isLast = k === starts.length - 1;
  const start = starts[k];
  const end = isLast ? line.lyrics.length : starts[k + 1];
  const lastCol = isLast ? Infinity : Math.max(end - start - 1, 0);
  const kept = line.chords.filter((a) => !(a.i >= start && (isLast || a.i < end)));
  const typed = chordsLineToAnchors(rowChordsText).map((a) => ({ i: Math.min(a.i, lastCol) + start, c: a.c }));
  return [...kept, ...typed].sort(byIndex);
}

/**
 * Chords after a paragraph's lyrics went from `oldText` to `newText` by an
 * edit that left the caret at `caret`: each chord stays over the character it
 * was over as the words it marks move, and a chord over deleted text moves to
 * where the deletion happened. Chords past the end of the lyrics (an ending
 * chord, or a chords-only line) keep their place, so typing at the end of the
 * line doesn't shove them along.
 */
export function moveChordsForEdit(chords, oldText, newText, caret) {
  const delta = newText.length - oldText.length;
  // Where the edit happened: the caret pins it down even inside a run of
  // repeated letters, where a plain text diff can't tell which one changed.
  let start = delta > 0 ? caret - delta : caret;
  let oldEnd = delta > 0 ? start : caret - delta;
  const tail = oldText.length - oldEnd;
  const caretConsistent = start >= 0 && start <= oldEnd && oldEnd <= oldText.length &&
    tail <= newText.length - start &&
    newText.slice(0, start) === oldText.slice(0, start) &&
    newText.slice(newText.length - tail) === oldText.slice(oldEnd);
  if (!caretConsistent) {
    start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
    let suffix = 0;
    while (suffix < Math.min(oldText.length, newText.length) - start &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
    oldEnd = oldText.length - suffix;
  }
  return chords.map((a) => {
    if (a.i < start || a.i >= oldText.length) return a;
    if (a.i >= oldEnd) return { ...a, i: a.i + delta };
    return { ...a, i: start };
  });
}

/**
 * `line` with its lyrics replaced by `newLyrics`, edited with the caret
 * ending at `caret`, its chords moved along with the text (see
 * `moveChordsForEdit`).
 */
export function editLyrics(line, newLyrics, caret) {
  return { ...line, lyrics: newLyrics, chords: moveChordsForEdit(line.chords, line.lyrics, newLyrics, caret) };
}

/** How many UTF-16 units the character ending at `offset` takes (2 for a surrogate pair). */
export function charLengthBefore(text, offset) {
  return offset >= 2 && isLowSurrogate(text, offset - 1) && isHighSurrogate(text, offset - 2) ? 2 : 1;
}

/** How many UTF-16 units the character starting at `offset` takes (2 for a surrogate pair). */
export function charLengthAt(text, offset) {
  return offset + 1 < text.length && isHighSurrogate(text, offset) && isLowSurrogate(text, offset + 1) ? 2 : 1;
}

/**
 * Enter: splits `line` at `at`, like any text editor. Everything after the
 * caret becomes a new paragraph below (empty when the caret was at the end),
 * with a new id, taking the chords at or after the caret with it.
 */
export function splitParagraph(line, at) {
  return [
    { ...line, lyrics: line.lyrics.slice(0, at), chords: line.chords.filter((a) => a.i < at) },
    {
      id: uuidv4(),
      lyrics: line.lyrics.slice(at),
      chords: line.chords.filter((a) => a.i >= at).map((a) => ({ ...a, i: a.i - at })),
    },
  ];
}

/**
 * Joins `below` onto the end of `above` with nothing added or removed between
 * them: backspace at the start of a real line (which is also how an empty
 * line gets deleted). A chord sitting past the end of `above`'s lyrics (an
 * ending chord, or a chords-only line) keeps its place: the joined line's
 * chords start after it rather than landing on top of it.
 */
export function joinParagraphs(above, below) {
  const chordShift = Math.max(above.lyrics.length, ...above.chords.map((a) => a.i + a.c.length));
  return {
    ...above,
    lyrics: above.lyrics + below.lyrics,
    chords: [...above.chords, ...below.chords.map((a) => ({ ...a, i: a.i + chordShift }))].sort(byIndex),
  };
}

/**
 * Inserts `text` over `[from, to)` of `line`. Text containing newlines splits
 * into paragraphs at them: the first keeps `line`'s id, the rest get new ones,
 * and each takes the chords over its own text. Returns the paragraphs and
 * where the caret lands (the end of what was inserted) as `[index, offset]`.
 */
export function insertText(line, from, to, text) {
  const inserted = text.replace(/\r\n?/g, '\n');
  const lyrics = line.lyrics.slice(0, from) + inserted + line.lyrics.slice(to);
  const caretOffset = from + inserted.length;
  const edited = editLyrics(line, lyrics, caretOffset);
  const segments = lyrics.split('\n');
  const paragraphs = [];
  let caret = null;
  let segStart = 0;
  segments.forEach((seg, k) => {
    const segEnd = segStart + seg.length;
    const isLast = k === segments.length - 1;
    paragraphs.push({
      id: k === 0 ? line.id : uuidv4(),
      lyrics: seg,
      chords: edited.chords
        .filter((a) => a.i >= segStart && (isLast || a.i <= segEnd))
        .map((a) => ({ ...a, i: a.i - segStart })),
    });
    if (caret === null && caretOffset <= segEnd) caret = [k, Math.max(caretOffset - segStart, 0)];
    segStart = segEnd + 1;
  });
  return { paragraphs, caret };
}

/**
 * Applies `capacity` to a chords-track edit like a maxlength, with one
 * allowance: spaces trailing after the edit are alignment padding (see
 * `renderChordAnchors`), not content, so an insertion may consume them before
 * anything is refused -- otherwise a chord row padded out under a full lyric
 * row would refuse every keystroke. An insertion that only partly fits keeps
 * what fits (a paste is truncated); one that can't fit at all is dropped and
 * the row stays as it was (`null` is returned). Edits that don't lengthen the
 * row always go through, so a row already over the limit can still be
 * shortened. Returns `{ text, caret }`.
 */
export function capChordInput(oldText, newText, newCaret, capacity) {
  if (newText.length <= capacity || newText.length <= oldText.length) return { text: newText, caret: newCaret };

  // What was inserted: the caret pins it down (a text diff alone can't tell
  // which side of a run of padding spaces a typed space went), else a diff.
  let prefix = newCaret - (newText.length - oldText.length);
  let suffixStart = newCaret;
  if (!(prefix >= 0 && newText.slice(0, prefix) === oldText.slice(0, prefix) &&
    newText.slice(newCaret) === oldText.slice(prefix))) {
    prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
    const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
    let suffix = 0;
    while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
    suffixStart = newText.length - suffix;
  }

  const before = newText.slice(0, prefix);
  let inserted = newText.slice(prefix, suffixStart);
  let after = newText.slice(suffixStart);

  const overBy = before.length + inserted.length + after.length - capacity;
  const trailingPadding = after.length - after.trimEnd().length;
  after = after.slice(0, after.length - Math.min(overBy, trailingPadding));

  const stillOver = before.length + inserted.length + after.length - capacity;
  if (stillOver > 0) {
    let keep = Math.max(inserted.length - stillOver, 0);
    if (keep > 0 && isHighSurrogate(inserted, keep - 1)) keep--;
    inserted = inserted.slice(0, keep);
  }
  if (inserted.length === 0) return null;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
