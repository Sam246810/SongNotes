import { describe, it, expect } from 'vitest';
import { columnBreaks, cutIntoRows, wrapSongToColumns } from '../utils/lineWrap';

// Ports of SongNotes-Android's LineWrapTest.kt, case for case, so the two
// implementations are held to the same behaviour.

function rows(text, maxColumns) {
  const starts = columnBreaks(text, maxColumns);
  return starts.map((start, k) => text.slice(start, starts[k + 1] ?? text.length));
}

function song(...lines) {
  return { id: 's', title: 'T', lines };
}

describe('columnBreaks', () => {
  it("moves a word that doesn't fit down whole, and the space before it hangs", () => {
    expect(rows('the quick brown fox', 12)).toEqual(['the quick ', 'brown fox']);
  });

  it('hangs a space exactly at the column limit instead of starting the next row with it', () => {
    expect(rows('abcdef ghi', 6)).toEqual(['abcdef ', 'ghi']);
  });

  it('cuts a run with no space at the last column that fits', () => {
    expect(rows('abcdefghijk', 5)).toEqual(['abcde', 'fghij', 'k']);
  });

  it('keeps a line that fits as one row, including an empty one', () => {
    expect(columnBreaks('short', 40)).toEqual([0]);
    expect(columnBreaks('', 40)).toEqual([0]);
  });

  it('never splits a surrogate pair across rows', () => {
    const text = 'abcd🎸ef'; // guitar emoji at index 4..5
    for (const row of rows(text, 5)) {
      const first = row.charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff, `row starts mid-pair: ${row}`).toBe(false);
    }
  });
});

describe('cutIntoRows', () => {
  it('moves each chord onto the row of the lyric character it sits above', () => {
    const chords = [{ i: 0, c: 'G' }, { i: 10, c: 'C' }, { i: 16, c: 'D' }];
    const result = cutIntoRows('the quick brown fox', chords, [0, 10]);
    expect(result[0]).toEqual({ lyrics: 'the quick ', chords: [{ i: 0, c: 'G' }] });
    expect(result[1]).toEqual({ lyrics: 'brown fox', chords: [{ i: 0, c: 'C' }, { i: 6, c: 'D' }] });
  });

  it('keeps chords past the end of the lyrics on the last row', () => {
    const result = cutIntoRows('la la', [{ i: 9, c: 'Em' }], [0, 3]);
    expect(result[1].chords).toEqual([{ i: 6, c: 'Em' }]);
  });
});

describe('wrapSongToColumns', () => {
  it('splits each line into rows and trims the hanging space', () => {
    const wrapped = wrapSongToColumns(song({ id: 'a', lyrics: 'the quick brown fox', chords: [{ i: 10, c: 'Am' }] }), 12);
    expect(wrapped.lines.map((l) => l.lyrics)).toEqual(['the quick', 'brown fox']);
    expect(wrapped.lines.map((l) => l.chords)).toEqual([[], [{ i: 0, c: 'Am' }]]);
  });

  it('leaves short lines exactly as they were', () => {
    const line = { id: 'a', lyrics: 'short', chords: [{ i: 0, c: 'G' }] };
    expect(wrapSongToColumns(song(line), 40).lines).toEqual([line]);
  });

  it('continues chords running past the column limit after the lyrics on their own row', () => {
    const line = { id: 'a', lyrics: '', chords: [{ i: 0, c: 'G' }, { i: 6, c: 'C' }, { i: 12, c: 'D' }] };
    const wrapped = wrapSongToColumns(song(line), 10);
    expect(wrapped.lines.map((l) => l.chords)).toEqual([[{ i: 0, c: 'G' }, { i: 6, c: 'C' }], [{ i: 0, c: 'D' }]]);
  });

  // `formatSongAsText of a wrapped song keeps every chord over its word` is
  // in export.test.js, next to songAsText.
});
