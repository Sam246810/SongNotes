import { describe, it, expect } from 'vitest';
import { transposeChordToken, transposeChordsLine } from '../utils/transpose';

describe('transposeChordToken', () => {
  it('shifts a simple major chord up', () => {
    expect(transposeChordToken('C', 2)).toBe('D');
  });

  it('shifts a simple major chord down', () => {
    expect(transposeChordToken('D', -2)).toBe('C');
  });

  it('wraps around the top of the octave', () => {
    expect(transposeChordToken('B', 1)).toBe('C');
  });

  it('wraps around the bottom of the octave', () => {
    expect(transposeChordToken('C', -1)).toBe('B');
  });

  it('preserves a minor quality suffix', () => {
    expect(transposeChordToken('Am', 3)).toBe('Cm');
  });

  it('preserves an extended quality suffix', () => {
    expect(transposeChordToken('Gmaj7', 2)).toBe('Amaj7');
    expect(transposeChordToken('Dsus4', 5)).toBe('Gsus4');
    expect(transposeChordToken('Em7', -2)).toBe('Dm7');
  });

  it('transposes both the root and the slash-bass note', () => {
    expect(transposeChordToken('D/F#', 2)).toBe('E/G#');
  });

  it('normalizes flat root spelling to sharp on output', () => {
    expect(transposeChordToken('Bb', 1)).toBe('B');
    expect(transposeChordToken('Db', 0 - 1)).toBe('C');
  });

  it('returns the original text unchanged for zero semitones', () => {
    expect(transposeChordToken('G', 0)).toBe('G');
  });

  it('leaves non-chord-shaped text untouched', () => {
    expect(transposeChordToken('(fast)', 2)).toBe('(fast)');
    expect(transposeChordToken('', 2)).toBe('');
  });

  it('a full octave (12 semitones) returns to the same chord', () => {
    expect(transposeChordToken('F#m7', 12)).toBe('F#m7');
    expect(transposeChordToken('F#m7', -12)).toBe('F#m7');
  });
});

describe('transposeChordsLine', () => {
  it('transposes every recognized chord in a chords-track string', () => {
    expect(transposeChordsLine('G          C          D', 2)).toBe('A          D          E');
  });

  it('leaves whitespace-only or empty input unchanged', () => {
    expect(transposeChordsLine('', 2)).toBe('');
    expect(transposeChordsLine('     ', 2)).toBe('     ');
  });

  it('leaves an unrecognized token untouched while still transposing the rest', () => {
    expect(transposeChordsLine('G    (slow)    D', 2)).toBe('A    (slow)    E');
  });

  it('returns the original string unchanged for zero semitones', () => {
    const line = 'G          C          D';
    expect(transposeChordsLine(line, 0)).toBe(line);
  });

  it('handles a mix of qualities and slash chords on one line', () => {
    expect(transposeChordsLine('Am7   D/F#   Gmaj7', -2)).toBe('Gm7   C/E   Fmaj7');
  });
});
