/**
 * Export utilities for SongNotes documents.
 * Formats a song into Ultimate Guitar-style chord/lyric pairs.
 */
import { anchorsToChordsLine } from './chordAnchors';
import { wrapSongToColumns } from './lineWrap';

/**
 * Width plain-text exports wrap lines to -- the Android app's
 * `TEXT_EXPORT_COLUMNS` (ExportActions.kt), so both apps produce the same
 * text. A saved line is a whole paragraph, as long as the user typed it, and
 * its chords only line up while the chord line and the lyric line each stay
 * on one line -- if whatever opens the file soft-wraps them, the chords end
 * up over the wrong words. Wrapping ourselves at a width most viewers show
 * unwrapped keeps them aligned.
 */
export const TEXT_EXPORT_COLUMNS = 60;

/**
 * Converts a song object to plain text.
 * Chord line sits directly above lyric line. Takes lines with `chords` as a
 * padded string (wire-format v1's shape) and prints them exactly as given;
 * byte-identical to the Android app's `formatSongAsText`, which both apps
 * check against spec/export-to-text.json. Songs go through `songAsText`.
 */
export function exportToText(song) {
  const title = song.title || 'Untitled';
  const header = `${title}\n${'='.repeat(title.length)}\n\n`;

  const body = song.lines
    .map((line) => {
      const hasChords = line.chords.trim().length > 0;
      const hasLyrics = line.lyrics.trim().length > 0;
      if (!hasChords && !hasLyrics) return '';
      if (hasChords && hasLyrics) return `${line.chords}\n${line.lyrics}`;
      if (hasChords) return line.chords;
      return line.lyrics;
    })
    .join('\n');

  return header + body;
}

/**
 * The plain text a song exports as: each line wrapped to
 * `TEXT_EXPORT_COLUMNS` (chords kept over their words, hanging spaces
 * trimmed), its chords rendered as a padded string, then `exportToText`.
 * Same steps, and so the same text, as the Android app's Copy and .txt.
 */
export function songAsText(song) {
  const wrapped = wrapSongToColumns(song, TEXT_EXPORT_COLUMNS);
  return exportToText({
    ...wrapped,
    lines: wrapped.lines.map((l) => ({ ...l, chords: anchorsToChordsLine(l.lyrics.length, l.chords) })),
  });
}

/**
 * Triggers a browser download of a .txt file.
 */
export function downloadText(song) {
  const content = songAsText(song);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(song.title)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Uses window.print() to trigger the browser's print-to-PDF dialog. What
 * prints is the editor's PrintSheet (the song wrapped to the page, chords
 * over their words), not the editor itself -- see the @media print rules in
 * global.css.
 */
export function exportToPdf() {
  window.print();
}

function sanitizeFilename(name) {
  return (name || 'song').replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '_') || 'song';
}
