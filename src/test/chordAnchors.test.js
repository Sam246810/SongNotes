import { describe, it, expect } from 'vitest';
import { chordsLineToAnchors, anchorsToChordsLine } from '../utils/chordAnchors';

/**
 * Same test cases as SongNotes-Android's ChordAnchorsTest.kt, since this is a
 * line-for-line port of that file (itself written directly from
 * docs/WIRE-FORMAT-v2.md section 4, no earlier JS version to port from) --
 * both platforms should agree on every one of these.
 */
describe('chordsLineToAnchors', () => {
  it('finds maximal non-whitespace runs at their start column', () => {
    const input = 'G' + ' '.repeat(10) + 'C'; // C starts at index 11
    expect(chordsLineToAnchors(input)).toEqual([{ i: 0, c: 'G' }, { i: 11, c: 'C' }]);
  });

  it("preserves leading whitespace as the first anchor's column", () => {
    expect(chordsLineToAnchors('   Am')).toEqual([{ i: 3, c: 'Am' }]);
  });

  it('handles adjacent chords with zero gap as one run', () => {
    // No whitespace between "G" and "C" means they're one non-whitespace run,
    // "GC" -- a degenerate/malformed input, not something a real chords-track
    // line produces, but the function must not crash.
    expect(chordsLineToAnchors('GC')).toEqual([{ i: 0, c: 'GC' }]);
  });

  it('returns an empty array for null, empty, or whitespace-only input', () => {
    expect(chordsLineToAnchors(null)).toEqual([]);
    expect(chordsLineToAnchors('')).toEqual([]);
    expect(chordsLineToAnchors('    ')).toEqual([]);
  });
});

describe('anchorsToChordsLine', () => {
  it("renders each chord at its column, padded to lyrics length", () => {
    const chords = [{ i: 0, c: 'G' }, { i: 11, c: 'C' }];
    expect(anchorsToChordsLine(12, chords)).toBe('G' + ' '.repeat(10) + 'C');
  });

  it("extends past lyricsLength when a chord's span exceeds it", () => {
    // A chord placed past a short lyric line's end -- valid per wire-format §4.
    const chords = [{ i: 10, c: 'Dsus4' }];
    const result = anchorsToChordsLine(3, chords);
    expect(result).toBe(' '.repeat(10) + 'Dsus4');
    expect(result.length).toBe(15);
  });

  it('handles an all-instrumental empty-lyrics line', () => {
    const chords = [{ i: 0, c: 'G' }, { i: 4, c: 'C' }, { i: 8, c: 'D' }];
    expect(anchorsToChordsLine(0, chords)).toBe('G   C   D');
  });

  it('returns spaces when there are no chords', () => {
    expect(anchorsToChordsLine(5, [])).toBe('     ');
  });

  it('resolves overlapping columns with later-in-sort-order wins', () => {
    // Both anchors start at column 0; "Am" (first) is written, then "C"
    // (second, same i, stable-sort tie-break keeps it second) overwrites only
    // the single column it actually spans -- the trailing "m" from "Am" is
    // untouched, since the algorithm overwrites at each i rather than
    // clearing the earlier anchor's whole span first.
    const chords = [{ i: 0, c: 'Am' }, { i: 0, c: 'C' }];
    expect(anchorsToChordsLine(2, chords)).toBe('Cm');
  });

  it('resolves a longer chord overwriting a shorter one at an overlapping later column', () => {
    // "Am7" occupies columns 0-2; "C" at column 1 (sorted after Am7 by start
    // column) partially overwrites it.
    const chords = [{ i: 0, c: 'Am7' }, { i: 1, c: 'C' }];
    expect(anchorsToChordsLine(3, chords)).toBe('AC7');
  });

  it('round-trips with chordsLineToAnchors for non-overlapping chords', () => {
    const original = 'G          C          D';
    const anchors = chordsLineToAnchors(original);
    expect(anchorsToChordsLine(original.length, anchors)).toBe(original);
  });
});
