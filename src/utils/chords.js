/**
 * SongNotes Chord Database
 * frets: [lowE, A, D, G, B, highE] — -1=muted, 0=open, N=absolute fret number
 * baseFret: start of 4-fret display window (default 1)
 * barre: { fret, fromString, toString } (0-indexed string numbers, lowE=0)
 */
export const CHORD_DB = {
  // === MAJOR ===
  C: { frets: [-1, 3, 2, 0, 1, 0], baseFret: 1 },
  D: { frets: [-1, -1, 0, 2, 3, 2], baseFret: 1 },
  E: { frets: [0, 2, 2, 1, 0, 0], baseFret: 1 },
  F: { frets: [1, 3, 3, 2, 1, 1], baseFret: 1, barre: { fret: 1, fromString: 0, toString: 5 } },
  G: { frets: [3, 2, 0, 0, 0, 3], baseFret: 1 },
  A: { frets: [-1, 0, 2, 2, 2, 0], baseFret: 1 },
  B: { frets: [-1, 2, 4, 4, 4, 2], baseFret: 2, barre: { fret: 2, fromString: 1, toString: 5 } },
  Bb: { frets: [-1, 1, 3, 3, 3, 1], baseFret: 1, barre: { fret: 1, fromString: 1, toString: 5 } },
  Eb: { frets: [-1, -1, 1, 3, 4, 3], baseFret: 1 },
  Ab: { frets: [4, 6, 6, 5, 4, 4], baseFret: 4, barre: { fret: 4, fromString: 0, toString: 5 } },
  Db: { frets: [-1, 4, 6, 6, 6, 4], baseFret: 4, barre: { fret: 4, fromString: 1, toString: 5 } },
  'F#': { frets: [2, 4, 4, 3, 2, 2], baseFret: 2, barre: { fret: 2, fromString: 0, toString: 5 } },
  Gb: { frets: [2, 4, 4, 3, 2, 2], baseFret: 2, barre: { fret: 2, fromString: 0, toString: 5 } },
  'C#': { frets: [-1, 4, 6, 6, 6, 4], baseFret: 4, barre: { fret: 4, fromString: 1, toString: 5 } },
  'G#': { frets: [4, 6, 6, 5, 4, 4], baseFret: 4, barre: { fret: 4, fromString: 0, toString: 5 } },
  'A#': { frets: [-1, 1, 3, 3, 3, 1], baseFret: 1, barre: { fret: 1, fromString: 1, toString: 5 } },
  'D#': { frets: [-1, -1, 1, 3, 4, 3], baseFret: 1 },
  // === MINOR ===
  Am: { frets: [-1, 0, 2, 2, 1, 0], baseFret: 1 },
  Bm: { frets: [-1, 2, 4, 4, 3, 2], baseFret: 2, barre: { fret: 2, fromString: 1, toString: 5 } },
  Cm: { frets: [-1, 3, 5, 5, 4, 3], baseFret: 3, barre: { fret: 3, fromString: 1, toString: 5 } },
  Dm: { frets: [-1, -1, 0, 2, 3, 1], baseFret: 1 },
  Em: { frets: [0, 2, 2, 0, 0, 0], baseFret: 1 },
  Fm: { frets: [1, 3, 3, 1, 1, 1], baseFret: 1, barre: { fret: 1, fromString: 0, toString: 5 } },
  Gm: { frets: [3, 5, 5, 3, 3, 3], baseFret: 3, barre: { fret: 3, fromString: 0, toString: 5 } },
  Bbm: { frets: [-1, 1, 3, 3, 2, 1], baseFret: 1, barre: { fret: 1, fromString: 1, toString: 5 } },
  'F#m': { frets: [2, 4, 4, 2, 2, 2], baseFret: 2, barre: { fret: 2, fromString: 0, toString: 5 } },
  Gbm: { frets: [2, 4, 4, 2, 2, 2], baseFret: 2, barre: { fret: 2, fromString: 0, toString: 5 } },
  'C#m': { frets: [-1, 4, 6, 6, 5, 4], baseFret: 4, barre: { fret: 4, fromString: 1, toString: 5 } },
  Dbm: { frets: [-1, 4, 6, 6, 5, 4], baseFret: 4, barre: { fret: 4, fromString: 1, toString: 5 } },
  'G#m': { frets: [4, 6, 6, 4, 4, 4], baseFret: 4, barre: { fret: 4, fromString: 0, toString: 5 } },
  Abm: { frets: [4, 6, 6, 4, 4, 4], baseFret: 4, barre: { fret: 4, fromString: 0, toString: 5 } },
  'D#m': { frets: [-1, 6, 8, 8, 7, 6], baseFret: 6, barre: { fret: 6, fromString: 1, toString: 5 } },
  // === DOMINANT 7 ===
  C7: { frets: [-1, 3, 2, 3, 1, 0], baseFret: 1 },
  D7: { frets: [-1, -1, 0, 2, 1, 2], baseFret: 1 },
  E7: { frets: [0, 2, 0, 1, 0, 0], baseFret: 1 },
  F7: { frets: [1, 3, 1, 2, 1, 1], baseFret: 1, barre: { fret: 1, fromString: 0, toString: 5 } },
  G7: { frets: [3, 2, 0, 0, 0, 1], baseFret: 1 },
  A7: { frets: [-1, 0, 2, 0, 2, 0], baseFret: 1 },
  B7: { frets: [-1, 2, 1, 2, 0, 2], baseFret: 1 },
  Bb7: { frets: [-1, 1, 3, 1, 3, 1], baseFret: 1, barre: { fret: 1, fromString: 1, toString: 5 } },
  // === MAJOR 7 ===
  Cmaj7: { frets: [-1, 3, 2, 0, 0, 0], baseFret: 1 },
  Dmaj7: { frets: [-1, -1, 0, 2, 2, 2], baseFret: 1 },
  Emaj7: { frets: [0, 2, 1, 1, 0, 0], baseFret: 1 },
  Fmaj7: { frets: [-1, -1, 3, 2, 1, 0], baseFret: 1 },
  Gmaj7: { frets: [3, 2, 0, 0, 0, 2], baseFret: 1 },
  Amaj7: { frets: [-1, 0, 2, 1, 2, 0], baseFret: 1 },
  // === MINOR 7 ===
  Am7: { frets: [-1, 0, 2, 0, 1, 0], baseFret: 1 },
  Bm7: { frets: [-1, 2, 4, 2, 3, 2], baseFret: 2, barre: { fret: 2, fromString: 1, toString: 5 } },
  Cm7: { frets: [-1, 3, 5, 3, 4, 3], baseFret: 3, barre: { fret: 3, fromString: 1, toString: 5 } },
  Dm7: { frets: [-1, -1, 0, 2, 1, 1], baseFret: 1 },
  Em7: { frets: [0, 2, 0, 0, 0, 0], baseFret: 1 },
  Fm7: { frets: [1, 3, 1, 1, 1, 1], baseFret: 1, barre: { fret: 1, fromString: 0, toString: 5 } },
  Gm7: { frets: [3, 5, 3, 3, 3, 3], baseFret: 3, barre: { fret: 3, fromString: 0, toString: 5 } },
  // === SUS ===
  Asus2: { frets: [-1, 0, 2, 2, 0, 0], baseFret: 1 },
  Asus4: { frets: [-1, 0, 2, 2, 3, 0], baseFret: 1 },
  Dsus2: { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  Dsus4: { frets: [-1, -1, 0, 2, 3, 3], baseFret: 1 },
  Esus4: { frets: [0, 2, 2, 2, 0, 0], baseFret: 1 },
  Gsus4: { frets: [3, 3, 0, 0, 1, 3], baseFret: 1 },
  // === ADD ===
  Cadd9: { frets: [-1, 3, 2, 0, 3, 3], baseFret: 1 },
  Gadd9: { frets: [3, 2, 0, 2, 0, 3], baseFret: 1 },
  Dadd9: { frets: [-1, -1, 0, 2, 3, 0], baseFret: 1 },
  // === DIM ===
  Bdim: { frets: [-1, 2, 3, 4, -1, -1], baseFret: 1 },
  Adim: { frets: [-1, 0, 1, 2, -1, -1], baseFret: 1 },
  Edim: { frets: [0, 1, 2, 3, -1, -1], baseFret: 1 },
  // === POWER ===
  A5: { frets: [-1, 0, 2, 2, -1, -1], baseFret: 1 },
  E5: { frets: [0, 2, 2, -1, -1, -1], baseFret: 1 },
  G5: { frets: [3, 5, 5, -1, -1, -1], baseFret: 3 },
  D5: { frets: [-1, -1, 0, 2, 3, -1], baseFret: 1 },
};

// Enharmonic aliases → normalize to the key stored above
const ENHARMONIC = {
  'Gb': 'F#', 'Gbm': 'F#m', 'Gb7': 'F#7',
  'Cb': 'B', 'Cbm': 'Bm',
  'Fb': 'E', 'Fbm': 'Em',
};

/**
 * Normalize a raw user-typed chord name to a canonical key in CHORD_DB.
 * Returns the canonical name, or the normalized name (even if not in DB).
 */
export function normalizeChordName(raw) {
  if (!raw || !raw.trim()) return '';
  const s = raw.trim();

  // Root note
  const root = s[0].toUpperCase();
  let rest = s.slice(1);

  // Accidental right after root
  let acc = '';
  if (rest[0] === '#') { acc = '#'; rest = rest.slice(1); }
  else if (rest[0] === 'b' && rest.length > 0 && !/^[0-9]/.test(rest.slice(1) ?? '')) {
    // treat 'b' as flat only if next char is not a digit (e.g. "Db" not "D7")
    acc = 'b'; rest = rest.slice(1);
  }

  // Normalize quality suffixes
  rest = rest
    .replace(/^minor\b/i, 'm')
    .replace(/^min\b/i, 'm')
    .replace(/^maj7\b/i, 'maj7')
    .replace(/^maj9\b/i, 'maj9')
    .replace(/^maj\b/i, '')
    .replace(/^M\b/, '')
    .replace(/^add9\b/i, 'add9')
    .replace(/^add11\b/i, 'add11')
    .replace(/^sus2\b/i, 'sus2')
    .replace(/^sus4\b/i, 'sus4')
    .replace(/^sus\b/i, 'sus4')
    // strip slash bass note
    .replace(/\/[A-G][b#]?\s*$/, '')
    .trim();

  const name = root + acc + rest;
  return ENHARMONIC[name] ?? name;
}

/**
 * Look up a raw chord name in the DB.
 * Returns the chord data object or null.
 */
export function lookupChord(raw) {
  const name = normalizeChordName(raw);
  return name ? (CHORD_DB[name] ?? null) : null;
}

/**
 * Tokenize a chord-track string into an array of tokens.
 * Each token: { text, isChord, chordName? }
 * Whitespace runs become isChord:false tokens.
 */
export function tokenizeChordLine(text) {
  if (!text) return [];
  const tokens = [];
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      tokens.push({ text: part, isChord: false, isWhitespace: true });
    } else {
      const chordName = normalizeChordName(part);
      const inDb = !!CHORD_DB[chordName];
      tokens.push({
        text: part,
        isChord: inDb,
        isWhitespace: false,
        // Always provide chordName so even unknown words get a popup
        chordName: chordName || part,
      });
    }
  }
  return tokens;
}

/**
 * Ensures chords line aligns in length with lyrics line.
 * - Pads with trailing spaces if chords are shorter.
 * - Trims trailing spaces if chords are longer, but only if they are spaces (no chord symbols).
 */
export function alignChordsWithLyrics(chords, lyrics) {
  const chordsStr = chords || '';
  const lyricsStr = lyrics || '';
  if (chordsStr.length < lyricsStr.length) {
    return chordsStr + ' '.repeat(lyricsStr.length - chordsStr.length);
  }
  if (chordsStr.length > lyricsStr.length) {
    const extra = chordsStr.slice(lyricsStr.length);
    if (/^\s*$/.test(extra)) {
      return chordsStr.slice(0, lyricsStr.length);
    }
  }
  return chordsStr;
}

