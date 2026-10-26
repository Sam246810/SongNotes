import { describe, it, expect } from 'vitest';
import {
  rowStarts, rowOfOffset, renderChordAnchors, layoutParagraph, replaceRowChords, moveChordsForEdit,
  editLyrics, splitParagraph, joinParagraphs, insertText, capChordInput, charLengthBefore, charLengthAt,
  mapOffsetThroughEdit,
} from '../utils/paragraphEditing';

const line = (lyrics, chords = [], id = 'p') => ({ id, lyrics, chords });

describe('rowStarts', () => {
  it('wraps like columnBreaks when the caret is elsewhere', () => {
    expect(rowStarts('the quick brown fox', 12)).toEqual([0, 10]);
  });

  it('keeps a word that exactly fills its row there when the space after it is typed', () => {
    expect(rowStarts('abcdef ', 6)).toEqual([0]);
  });

  it('opens an empty row for the caret after that space, only while the caret is at the end', () => {
    expect(rowStarts('abcdef ', 6, true)).toEqual([0, 7]);
    expect(rowStarts('abcdef', 6, true)).toEqual([0]); // no space typed yet
    expect(rowStarts('abc ', 6, true)).toEqual([0]); // the row isn't full
  });
});

describe('rowOfOffset', () => {
  it('puts an offset on a row boundary at the start of the next row', () => {
    expect(rowOfOffset([0, 10], 9)).toBe(0);
    expect(rowOfOffset([0, 10], 10)).toBe(1);
    expect(rowOfOffset([0, 10], 19)).toBe(1);
  });
});

describe('renderChordAnchors', () => {
  it('places each chord at its column and pads to the given width', () => {
    expect(renderChordAnchors([{ i: 0, c: 'G' }, { i: 6, c: 'C' }], 10)).toBe('G     C   ');
  });

  it('nudges a chord that would collide with the one before it, never fusing them', () => {
    expect(renderChordAnchors([{ i: 0, c: 'Am' }, { i: 1, c: 'G' }], 0)).toBe('Am G');
    expect(renderChordAnchors([{ i: 3, c: 'Am' }, { i: 3, c: 'G' }], 0)).toBe('   Am G');
  });
});

describe('layoutParagraph', () => {
  it('cuts a paragraph into rows with each chord over its letter', () => {
    const p = line('the quick brown fox', [{ i: 4, c: 'G' }, { i: 16, c: 'D' }]);
    expect(layoutParagraph(p, [0, 10], 12)).toEqual([
      { start: 0, lyrics: 'the quick ', chords: '    G     ' },
      { start: 10, lyrics: 'brown fox', chords: '      D  ' },
    ]);
  });

  it('keeps a chord ending one row and a chord starting the next apart (they would overlap as one string)', () => {
    const p = line('abcdefgh ijklmno', [{ i: 7, c: 'Am7' }, { i: 9, c: 'G' }]);
    const rows = layoutParagraph(p, [0, 9], 9);
    expect(rows[0].chords).toBe('       Am7');
    expect(rows[1].chords).toBe('G      ');
  });
});

describe('replaceRowChords', () => {
  const p = line('the quick brown fox', [{ i: 4, c: 'G' }, { i: 16, c: 'D' }]);

  it("replaces only the edited row's chords, at paragraph offsets", () => {
    expect(replaceRowChords(p, [0, 10], 1, 'C     D  ')).toEqual([{ i: 4, c: 'G' }, { i: 10, c: 'C' }, { i: 16, c: 'D' }]);
    expect(replaceRowChords(p, [0, 10], 0, '')).toEqual([{ i: 16, c: 'D' }]);
  });

  it("pins a chord typed past the end of a non-last row to that row's last character", () => {
    expect(replaceRowChords(p, [0, 10], 0, '    G         Em')).toEqual([{ i: 4, c: 'G' }, { i: 9, c: 'Em' }, { i: 16, c: 'D' }]);
  });

  it('keeps a chord past the end of the last row where it was typed (an ending chord)', () => {
    expect(replaceRowChords(p, [0, 10], 1, '      D     Em')).toEqual([{ i: 4, c: 'G' }, { i: 16, c: 'D' }, { i: 22, c: 'Em' }]);
  });
});

describe('moveChordsForEdit', () => {
  const chords = [{ i: 4, c: 'G' }, { i: 10, c: 'C' }, { i: 25, c: 'Em' }];
  const text = 'the quick brown fox';

  it('moves chords along with their letters when text is typed before them', () => {
    expect(moveChordsForEdit(chords, text, 'the very quick brown fox', 9)).toEqual([
      { i: 9, c: 'G' }, { i: 15, c: 'C' }, { i: 25, c: 'Em' },
    ]);
  });

  it('moves chords back when text before them is deleted, and a chord over deleted text to the deletion', () => {
    expect(moveChordsForEdit(chords, text, 'the brown fox', 4)).toEqual([
      { i: 4, c: 'G' }, { i: 4, c: 'C' }, { i: 25, c: 'Em' },
    ]);
  });

  it('leaves a chord past the end of the lyrics in place while typing at the end', () => {
    expect(moveChordsForEdit(chords, text, `${text}es`, text.length + 2)).toEqual(chords);
  });

  it('uses the caret to tell which of a run of repeated letters was typed', () => {
    // "aaa" -> "aaaa" with the caret after the first a: the chord on the 2nd a moves.
    expect(moveChordsForEdit([{ i: 1, c: 'G' }], 'aaa', 'aaaa', 1)).toEqual([{ i: 2, c: 'G' }]);
    expect(moveChordsForEdit([{ i: 1, c: 'G' }], 'aaa', 'aaaa', 3)).toEqual([{ i: 1, c: 'G' }]);
  });
});

describe('splitParagraph (Enter)', () => {
  it('sends everything after the caret, and its chords, to a new line with a new id', () => {
    const [before, after] = splitParagraph(line('the quick brown fox', [{ i: 4, c: 'G' }, { i: 10, c: 'C' }]), 10);
    expect(before).toEqual(line('the quick ', [{ i: 4, c: 'G' }]));
    expect(after.id).not.toBe('p');
    expect(after).toEqual({ id: after.id, lyrics: 'brown fox', chords: [{ i: 0, c: 'C' }] });
  });
});

describe('joinParagraphs (backspace at the start of a line)', () => {
  it('joins with nothing added between the lines, keeping the upper line id', () => {
    const joined = joinParagraphs(line('Hello ', [{ i: 0, c: 'Am' }], 'a'), line('world', [{ i: 0, c: 'G' }], 'b'));
    expect(joined).toEqual(line('Hello world', [{ i: 0, c: 'Am' }, { i: 6, c: 'G' }], 'a'));
  });

  it("starts the lower line's chords after an ending chord rather than on top of it", () => {
    const joined = joinParagraphs(line('Oh', [{ i: 4, c: 'Dsus4' }], 'a'), line('yes', [{ i: 0, c: 'G' }], 'b'));
    expect(joined.chords).toEqual([{ i: 4, c: 'Dsus4' }, { i: 9, c: 'G' }]);
  });
});

describe('insertText (paste)', () => {
  it('splits pasted text at newlines into new lines and lands the caret at the end of the paste', () => {
    const p = line('ab', [{ i: 1, c: 'G' }]);
    const { paragraphs, caret } = insertText(p, 1, 1, 'X\r\nY\nZ');
    expect(paragraphs.map((q) => q.lyrics)).toEqual(['aX', 'Y', 'Zb']);
    expect(paragraphs[0].id).toBe('p');
    expect(new Set(paragraphs.map((q) => q.id)).size).toBe(3);
    expect(paragraphs[2].chords).toEqual([{ i: 1, c: 'G' }]); // still over the "b"
    expect(caret).toEqual([2, 1]);
  });

  it('replaces a selection with single-line text', () => {
    const { paragraphs, caret } = insertText(line('the quick fox'), 4, 9, 'slow');
    expect(paragraphs).toEqual([line('the slow fox')]);
    expect(caret).toEqual([0, 8]);
  });
});

describe('editLyrics', () => {
  it('replaces the lyrics and moves the chords with them', () => {
    expect(editLyrics(line('ab', [{ i: 1, c: 'G' }]), 'aXb', 2)).toEqual(line('aXb', [{ i: 2, c: 'G' }]));
  });
});

describe('capChordInput', () => {
  it('lets an edit within the cap through unchanged', () => {
    expect(capChordInput('G', 'G C', 3, 10)).toEqual({ text: 'G C', caret: 3 });
  });

  it('refuses a keystroke at the end of a full chord row (never spills onto another row)', () => {
    expect(capChordInput('G    C', 'G    CD', 7, 6)).toBeNull();
  });

  it('lets typing consume trailing alignment padding before refusing anything', () => {
    expect(capChordInput('G     ', 'G C     ', 3, 6)).toEqual({ text: 'G C   ', caret: 3 });
  });

  it('truncates a paste to what fits', () => {
    expect(capChordInput('G', 'GAm7 C D', 8, 5)).toEqual({ text: 'GAm7 ', caret: 5 });
  });

  it('always lets a row already over the cap get shorter', () => {
    expect(capChordInput('G C D E F', 'G C D E', 7, 4)).toEqual({ text: 'G C D E', caret: 7 });
  });
});

describe('charLengthBefore / charLengthAt', () => {
  it('treats a surrogate pair as one character', () => {
    expect(charLengthBefore('a🎸', 3)).toBe(2);
    expect(charLengthBefore('ab', 2)).toBe(1);
    expect(charLengthAt('🎸a', 0)).toBe(2);
    expect(charLengthAt('ab', 0)).toBe(1);
  });
});

describe('mapOffsetThroughEdit', () => {
  it('keeps a caret before the change, and carries one after it along', () => {
    expect(mapOffsetThroughEdit('the cat sat', 'the big cat sat', 2)).toBe(2);
    expect(mapOffsetThroughEdit('the cat sat', 'the big cat sat', 9)).toBe(13);
    expect(mapOffsetThroughEdit('the cat sat', 'cat sat', 9)).toBe(5);
  });

  it('puts a caret inside the changed words at the end of what replaced them', () => {
    expect(mapOffsetThroughEdit('a dog here', 'a horse here', 3)).toBe(7);
  });

  it('stays within the new text', () => {
    expect(mapOffsetThroughEdit('abc', '', 2)).toBe(0);
  });
});
