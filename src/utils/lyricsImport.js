import { tokenizeChordLine } from './chords';

/**
 * Best-effort detector for "this line is a row of chord symbols sitting above
 * a lyric line" (the plain-text chord-chart convention where whitespace does
 * the aligning), e.g.:
 *
 *   G          C          D
 *   Amazing grace, how sweet the sound
 *
 * Reuses the same chord validation the editor's chord track already relies on
 * (tokenizeChordLine / CHORD_DB via normalizeChordName), plus two extra
 * filters aimed specifically at telling chord lines apart from prose:
 *   - a token only counts if its ORIGINAL text starts with an uppercase
 *     A-G, since normalizeChordName uppercases everything before lookup and
 *     would otherwise treat a lowercase word like "a" as chord A;
 *   - a line ending in normal sentence punctuation is never a chord line.
 */
export function looksLikeChordLine(text) {
  if (!text) return false;
  const trimmedEnd = text.replace(/\s+$/, '');
  if (!trimmedEnd.trim()) return false;
  if (/[.,!?;:]$/.test(trimmedEnd)) return false;

  const tokens = tokenizeChordLine(text).filter((t) => !t.isWhitespace);
  if (tokens.length === 0) return false;

  const chordLikeCount = tokens.filter((t) => t.isChord && /^[A-G]/.test(t.text)).length;
  return chordLikeCount / tokens.length >= 0.6;
}

// A second, equally common convention: chords bracketed on their own line —
// e.g. "[G#maj]" above "For all the heart I have", sometimes several per
// line ("[Fmin] [G#maj]"), sometimes with leading whitespace hinting at a
// column position, interspersed with bracketed section labels ("[Verse]",
// "[Chorus]") that must never be mistaken for a chord or swallowed as lyrics.
const SECTION_KEYWORDS = /^(verse|chorus|bridge|intro|outro|instrumental|interlude|pre-?chorus|post-?chorus|pre-?bridge|refrain|hook|solo|tag|breakdown|build|drop|ending|coda|vamp|turnaround)\b/i;

/** Is the text inside one [bracket] chord-shaped, as opposed to a section
 *  label like "Verse" or a freeform note? */
function looksLikeChordBracketContent(inner) {
  const trimmed = inner.trim();
  if (!trimmed) return false;
  if (SECTION_KEYWORDS.test(trimmed)) return false;
  if (!/^[A-G]/.test(trimmed)) return false;
  if (trimmed.length > 20) return false; // a real chord (even compound, e.g. "Cmaj-//-C#maj") is short; a phrase isn't
  return true;
}

/** Does this line consist ENTIRELY of one or more [bracket] groups — no text
 *  outside them (other than whitespace)? True for both chord cues and
 *  section markers; looksLikeBracketChordLine narrows it down further. */
function isPureBracketLine(text) {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes('[')) return false;
  return trimmed.replace(/\[[^\]]*\]/g, '').trim() === '';
}

/** A pure-bracket line whose bracket contents are (mostly) chord-shaped. */
function looksLikeBracketChordLine(text) {
  if (!isPureBracketLine(text)) return false;
  const brackets = [...text.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  if (brackets.length === 0) return false;
  const chordLikeCount = brackets.filter(looksLikeChordBracketContent).length;
  return chordLikeCount / brackets.length >= 0.6;
}

/** A line that starts with a bracketed section label, e.g. "[Bridge]" or
 *  "[Bridge] (very tentative)" — never a lyric, whatever follows the bracket. */
function startsWithSectionMarkerBracket(text) {
  const match = text.trim().match(/^\[([^\]]*)\]/);
  return !!match && SECTION_KEYWORDS.test(match[1].trim());
}

/** A candidate "next line" is only ever treated as sung lyrics if it isn't
 *  itself some flavor of chord/annotation line. */
function readsAsLyrics(text) {
  return (
    text !== undefined &&
    text.trim() !== '' &&
    !isPureBracketLine(text) &&
    !looksLikeChordLine(text) &&
    !startsWithSectionMarkerBracket(text)
  );
}

/** Converts a bracket chord-cue line into a bare chords-track string by
 *  stripping just the brackets — everything else, including whatever leading
 *  whitespace hints at the intended column, is left exactly as typed. */
function stripBracketsForChordsLine(text) {
  return text.replace(/[[\]]/g, '');
}

const TITLE_UNDERLINE_RE = /^[=-]{3,}\s*$/;
const META_HEADER_PATTERNS = {
  key: /^key\s*:\s*(.+)$/i,
  bpm: /^bpm\s*:\s*(.+)$/i,
  capo: /^capo\s*:\s*(.+)$/i,
  tuning: /^tuning\s*:\s*(.+)$/i,
};

/**
 * Parses raw imported text (from a pasted textarea, a .txt file, or PDF text
 * extraction) into the same { chords, lyrics } line shape the editor already
 * uses everywhere else — see createLine/alignChordsWithLyrics in songsStore.js.
 * Detection runs independently per line, so a false positive/negative on one
 * line never affects the rest of the song; the result is always meant to be
 * hand-edited afterward like any other pasted text.
 *
 * Understands two chord notations (freely mixed within the same file): bare
 * chords aligned above a lyric line via whitespace, and chords bracketed on
 * their own line (optionally several per line) — plus, if present, a small
 * "Key: .../BPM: .../Capo: .../Tuning: ..." header block up top, which maps
 * directly onto the same fields SongMetaBar shows on the lyric sheet.
 *
 * @param {string} rawText
 * @returns {{ title: string|null, meta: object, lines: Array<{chords: string, lyrics: string}> }}
 */
export function parseLyricsText(rawText) {
  const allLines = (rawText || '').replace(/\r\n?/g, '\n').split('\n');

  // Trim fully-blank lines from the start/end — leftover artifacts from
  // copy-paste or PDF extraction, not meaningful song content.
  let start = 0;
  let end = allLines.length;
  while (start < end && !allLines[start].trim()) start++;
  while (end > start && !allLines[end - 1].trim()) end--;
  let lines = allLines.slice(start, end);

  // Optional title header, matching exportToText's own format: a title line
  // followed by a row of =/- characters underlining it.
  let title = null;
  if (lines.length >= 2 && lines[0].trim() && TITLE_UNDERLINE_RE.test(lines[1])) {
    title = lines[0].trim();
    lines = lines.slice(2);
    if (lines.length > 0 && !lines[0].trim()) lines = lines.slice(1);
  }

  // Optional "Key: .../BPM: ..." reference header block, consumed from
  // wherever the leading run of header-shaped (or blank) lines ends.
  const meta = {};
  let lastHeaderIdx = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    // Trimmed for matching only — PDF-extracted text commonly carries a
    // uniform left-margin indent on every line, which would otherwise make
    // an anchored /^key:/ pattern miss a perfectly normal "Key: G" header.
    const line = lines[idx].trim();
    if (!line) continue; // blank lines inside the header block are fine
    const match = Object.entries(META_HEADER_PATTERNS).find(([, re]) => re.test(line));
    if (!match) break;
    const [field, re] = match;
    meta[field] = line.match(re)[1].trim();
    lastHeaderIdx = idx;
  }
  if (lastHeaderIdx >= 0) {
    lines = lines.slice(lastHeaderIdx + 1);
    while (lines.length > 0 && !lines[0].trim()) lines = lines.slice(1);
  }

  const result = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    if (!raw.trim()) {
      result.push({ chords: '', lyrics: '' });
      i += 1;
      continue;
    }

    if (looksLikeBracketChordLine(raw)) {
      const next = lines[i + 1];
      if (readsAsLyrics(next)) {
        result.push({ chords: stripBracketsForChordsLine(raw), lyrics: next });
        i += 2;
      } else {
        result.push({ chords: stripBracketsForChordsLine(raw), lyrics: '' });
        i += 1;
      }
      continue;
    }

    if (!isPureBracketLine(raw) && looksLikeChordLine(raw)) {
      const next = lines[i + 1];
      if (readsAsLyrics(next)) {
        result.push({ chords: raw, lyrics: next });
        i += 2;
      } else {
        result.push({ chords: raw, lyrics: '' });
        i += 1;
      }
      continue;
    }

    result.push({ chords: '', lyrics: raw });
    i += 1;
  }

  return { title, meta, lines: result };
}
