/**
 * Export utilities for SongNotes documents.
 * Formats a song into Ultimate Guitar-style chord/lyric pairs.
 */

/**
 * Converts a song object to plain text.
 * Chord line sits directly above lyric line.
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
 * Triggers a browser download of a .txt file.
 */
export function downloadText(song) {
  const content = exportToText(song);
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
 * Uses window.print() to trigger the browser's print-to-PDF dialog.
 * The global.css @media print rules handle the visual formatting.
 */
export function exportToPdf() {
  window.print();
}

function sanitizeFilename(name) {
  return (name || 'song').replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '_') || 'song';
}
