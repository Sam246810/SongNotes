import { CHORD_DB, normalizeChordName } from './chords';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const NOTE_TO_SEMITONE = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/** Shift a single note name (a chord's root, or a slash-bass note) by
 *  `semitones`, wrapping through the octave. Unrecognized input passes through. */
function transposeNoteName(note, semitones) {
  const semitone = NOTE_TO_SEMITONE[note];
  if (semitone === undefined) return note;
  const shifted = (((semitone + semitones) % 12) + 12) % 12;
  return SHARP_NAMES[shifted];
}

/**
 * Transposes one chord token's root — and its slash-bass note, if it has one
 * (e.g. "D/F#") — by `semitones`, always spelled with sharps. Everything else
 * about the token (its quality suffix: m7, sus4, maj7, ...) is left exactly
 * as typed; only the note letters move.
 */
export function transposeChordToken(raw, semitones) {
  if (!raw || !semitones) return raw;
  const rootMatch = raw.match(/^([A-G])([#b]?)/);
  if (!rootMatch) return raw;

  const [wholeRootMatch, root, accidental] = rootMatch;
  const rest = raw.slice(wholeRootMatch.length);
  const newRoot = transposeNoteName(root + accidental, semitones);

  const bassMatch = rest.match(/\/([A-G])([#b]?)\s*$/);
  if (bassMatch) {
    const [wholeBassMatch, bassRoot, bassAccidental] = bassMatch;
    const newBass = transposeNoteName(bassRoot + bassAccidental, semitones);
    const restBeforeBass = rest.slice(0, rest.length - wholeBassMatch.length);
    return `${newRoot}${restBeforeBass}/${newBass}`;
  }

  return newRoot + rest;
}

/**
 * Transposes every recognized chord in a chords-track string by `semitones`,
 * leaving whitespace and any non-chord text (section labels, typos) alone.
 * "Recognized" uses the same CHORD_DB lookup the editor's chord track already
 * relies on elsewhere, so this only ever touches tokens a user would actually
 * see rendered as a chord. A token changing width (e.g. "F#" -> "G") shifts
 * whatever comes after it on the same line, same as transposing in any other
 * chord-chart tool — callers should re-run alignChordsWithLyrics afterward
 * (songsStore's updateLine/transposeSong already do).
 */
export function transposeChordsLine(chordsLine, semitones) {
  if (!chordsLine || !semitones) return chordsLine;
  return chordsLine.replace(/\S+/g, (token) => {
    const normalized = normalizeChordName(token);
    if (!normalized || !CHORD_DB[normalized]) return token;
    return transposeChordToken(token, semitones);
  });
}
