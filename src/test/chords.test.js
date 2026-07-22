import { describe, it, expect } from 'vitest';
import {
  CHORD_DB,
  normalizeChordName,
  lookupChord,
  tokenizeChordLine,
  alignChordsWithLyrics,
} from '../utils/chords';

// ─────────────────────────────────────────────
// normalizeChordName
// ─────────────────────────────────────────────
describe('normalizeChordName', () => {
  it('capitalizes the root note', () => {
    expect(normalizeChordName('am')).toBe('Am');
    expect(normalizeChordName('c')).toBe('C');
    expect(normalizeChordName('g')).toBe('G');
  });

  it('handles sharp accidentals', () => {
    expect(normalizeChordName('F#')).toBe('F#');
    expect(normalizeChordName('f#m')).toBe('F#m');
    expect(normalizeChordName('C#m')).toBe('C#m');
  });

  it('handles flat accidentals', () => {
    expect(normalizeChordName('Bb')).toBe('Bb');
    expect(normalizeChordName('bb')).toBe('Bb');
    expect(normalizeChordName('Bbm')).toBe('Bbm');
    expect(normalizeChordName('Eb')).toBe('Eb');
  });

  it('normalises minor quality aliases', () => {
    expect(normalizeChordName('Amin')).toBe('Am');
    expect(normalizeChordName('aminor')).toBe('Am');
    expect(normalizeChordName('Amin')).toBe('Am');
  });

  it('normalises major quality (maj shorthand = major)', () => {
    expect(normalizeChordName('Cmaj')).toBe('C');
    expect(normalizeChordName('DM')).toBe('D');
  });

  it('preserves extended chord suffixes', () => {
    expect(normalizeChordName('Cmaj7')).toBe('Cmaj7');
    expect(normalizeChordName('Am7')).toBe('Am7');
    expect(normalizeChordName('Dsus4')).toBe('Dsus4');
    expect(normalizeChordName('Asus2')).toBe('Asus2');
    expect(normalizeChordName('Gadd9')).toBe('Gadd9');
  });

  it('strips slash-bass notation', () => {
    const name = normalizeChordName('G/B');
    // Should strip the /B part — result is just 'G'
    expect(name).toBe('G');
  });

  it('returns empty string for empty/null input', () => {
    expect(normalizeChordName('')).toBe('');
    expect(normalizeChordName(null)).toBe('');
    expect(normalizeChordName(undefined)).toBe('');
  });

  it('applies enharmonic aliases (Gb → F#)', () => {
    expect(normalizeChordName('Gb')).toBe('F#');
    expect(normalizeChordName('Gbm')).toBe('F#m');
  });
});

// ─────────────────────────────────────────────
// lookupChord
// ─────────────────────────────────────────────
describe('lookupChord', () => {
  it('finds common open chords', () => {
    expect(lookupChord('Am')).not.toBeNull();
    expect(lookupChord('G')).not.toBeNull();
    expect(lookupChord('C')).not.toBeNull();
    expect(lookupChord('Em')).not.toBeNull();
  });

  it('finds chords regardless of input case', () => {
    expect(lookupChord('am')).not.toBeNull();
    expect(lookupChord('AM')).not.toBeNull(); // A + M normalises to A
  });

  it('returns null for unknown chords like D6', () => {
    expect(lookupChord('D6')).toBeNull();
    expect(lookupChord('Cadd11')).toBeNull();
    expect(lookupChord('Xyzzy')).toBeNull();
  });

  it('returns correct fret data shape', () => {
    const am = lookupChord('Am');
    expect(am).toHaveProperty('frets');
    expect(am).toHaveProperty('baseFret');
    expect(am.frets).toHaveLength(6);
    expect(am.baseFret).toBe(1);
  });

  it('barre chords have barre property', () => {
    const f = lookupChord('F');
    expect(f).toHaveProperty('barre');
    expect(f.barre).toHaveProperty('fret');
    expect(f.barre).toHaveProperty('fromString');
    expect(f.barre).toHaveProperty('toString');
  });

  it('handles slash chords by stripping bass (G/B → G)', () => {
    expect(lookupChord('G/B')).not.toBeNull();
  });

  it('resolves enharmonic equivalents', () => {
    // Gb is stored as F# in the DB
    expect(lookupChord('Gb')).toStrictEqual(lookupChord('F#'));
  });
});

// ─────────────────────────────────────────────
// tokenizeChordLine
// ─────────────────────────────────────────────
describe('tokenizeChordLine', () => {
  it('returns empty array for empty/null input', () => {
    expect(tokenizeChordLine('')).toEqual([]);
    expect(tokenizeChordLine(null)).toEqual([]);
    expect(tokenizeChordLine(undefined)).toEqual([]);
  });

  it('tokenizes a simple chord line', () => {
    const tokens = tokenizeChordLine('Am G C');
    const words = tokens.filter((t) => !t.isWhitespace);
    expect(words).toHaveLength(3);
    expect(words.map((t) => t.isChord)).toEqual([true, true, true]);
  });

  it('preserves whitespace as separate tokens', () => {
    const tokens = tokenizeChordLine('Am  G');
    const spaces = tokens.filter((t) => t.isWhitespace);
    expect(spaces.length).toBeGreaterThan(0);
    expect(spaces[0].text).toMatch(/^\s+$/);
  });

  it('marks unknown chord-like words as isChord: false but not isWhitespace', () => {
    const tokens = tokenizeChordLine('D6 Am');
    const d6 = tokens.find((t) => t.text === 'D6');
    expect(d6).toBeDefined();
    expect(d6.isChord).toBe(false);
    expect(d6.isWhitespace).toBe(false);
    // chordName should still be set so popup can show 'no chart' message
    expect(d6.chordName).toBeTruthy();
  });

  it('marks known chords as isChord: true', () => {
    const tokens = tokenizeChordLine('Fmaj7');
    const tok = tokens.find((t) => !t.isWhitespace);
    expect(tok.isChord).toBe(true);
    expect(tok.chordName).toBe('Fmaj7');
  });

  it('handles leading/trailing spaces without crashing', () => {
    const tokens = tokenizeChordLine('  Am  ');
    const words = tokens.filter((t) => !t.isWhitespace);
    expect(words).toHaveLength(1);
    expect(words[0].isChord).toBe(true);
  });

  it('all non-whitespace tokens have a chordName property', () => {
    const tokens = tokenizeChordLine('Am D6 G Foo');
    const words = tokens.filter((t) => !t.isWhitespace);
    for (const tok of words) {
      expect(tok.chordName).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────
// CHORD_DB structural integrity
// ─────────────────────────────────────────────
describe('CHORD_DB structure', () => {
  it('every chord has a frets array of length 6', () => {
    for (const [name, data] of Object.entries(CHORD_DB)) {
      expect(data.frets, `${name}.frets length`).toHaveLength(6);
    }
  });

  it('every fret value is a valid number (-1, 0, or positive)', () => {
    for (const [name, data] of Object.entries(CHORD_DB)) {
      for (const f of data.frets) {
        expect(
          f === -1 || f >= 0,
          `${name} has invalid fret value: ${f}`
        ).toBe(true);
      }
    }
  });

  it('every chord has a baseFret >= 1', () => {
    for (const [name, data] of Object.entries(CHORD_DB)) {
      expect(data.baseFret ?? 1, `${name}.baseFret`).toBeGreaterThanOrEqual(1);
    }
  });

  it('if barre is present, fromString and toString are valid string indices', () => {
    for (const [name, data] of Object.entries(CHORD_DB)) {
      if (!data.barre) continue;
      const { fromString, toString } = data.barre;
      expect(fromString, `${name}.barre.fromString`).toBeGreaterThanOrEqual(0);
      expect(toString, `${name}.barre.toString`).toBeLessThanOrEqual(5);
      expect(fromString, `${name} barre from < to`).toBeLessThan(toString);
    }
  });
});

// ─────────────────────────────────────────────
// alignChordsWithLyrics
// ─────────────────────────────────────────────
describe('alignChordsWithLyrics', () => {
  it('returns empty string if both parameters are empty/null', () => {
    expect(alignChordsWithLyrics('', '')).toBe('');
    expect(alignChordsWithLyrics(null, null)).toBe('');
  });

  it('pads chords with trailing spaces if chords are shorter than lyrics', () => {
    expect(alignChordsWithLyrics('C', 'Hello')).toBe('C    ');
    expect(alignChordsWithLyrics('C G', 'Hello world')).toBe('C G        ');
  });

  it('trims trailing spaces from chords if chords are longer than lyrics and extra characters are only whitespace', () => {
    expect(alignChordsWithLyrics('C    ', 'Hi')).toBe('C ');
    expect(alignChordsWithLyrics('C G   ', 'Hello')).toBe('C G  ');
  });

  it('does NOT trim trailing chords or non-spaces if chords are longer than lyrics', () => {
    expect(alignChordsWithLyrics('C    G', 'Hi')).toBe('C    G');
    expect(alignChordsWithLyrics('C  Am  ', 'Hi')).toBe('C  Am  ');
  });
});

