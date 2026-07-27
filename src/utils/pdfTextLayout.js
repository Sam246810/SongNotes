/**
 * Pure text-layout reconstruction for PDF text items — deliberately kept free
 * of any pdfjs-dist import. pdfjs-dist references browser-only globals
 * (DOMMatrix, etc.) the moment it's imported, which crashes in the Vitest/
 * jsdom test environment; this module holds the actual reconstruction logic
 * so it stays unit-testable with plain synthetic item objects. See
 * pdfImport.js, which imports this and does the real pdfjs-dist plumbing.
 */

/**
 * Reconstructs one PDF page's text, inferring line breaks and an approximate
 * column alignment from each text item's on-page position.
 *
 * pdf.js's own getTextContent() returns text items in roughly reading order
 * but with no line breaks and no guarantee of matching horizontal spacing —
 * fine for prose, but it would silently destroy the one thing this importer
 * cares about most: chord symbols staying aligned above the lyric characters
 * they sit over. This reconstructs that layout the same way tools like
 * `pdftotext -layout` do — estimate a monospace-equivalent character width
 * from the text itself, then convert each item's x position into a column
 * index and pad with spaces to match.
 *
 * @param {Array<{str: string, transform: number[], width: number, height: number}>} items
 * @returns {string}
 */
export function reconstructPageText(items) {
  const usable = items.filter((it) => it.str && it.str.length > 0);
  if (usable.length === 0) return '';

  const avgCharWidth = estimateCharWidth(usable);
  // A page's content never starts at x=0 — there's always some margin. Left
  // uncorrected, that margin becomes a chunk of identical leading whitespace
  // on every single line, which isn't real indentation and shouldn't be
  // imported as if it were. Subtracting the leftmost x on the page normalizes
  // that away while leaving genuine RELATIVE indentation (e.g. a chord cue
  // nudged further right than the lyric line under it) untouched, since every
  // item shifts by the same constant amount.
  const minX = Math.min(...usable.map((it) => it.transform[4]));

  // Group items into visual rows by y-position (items on the same printed
  // line don't always report identical y due to sub-pixel/font metrics).
  const rows = [];
  for (const item of usable) {
    const y = item.transform[5];
    const tolerance = (item.height || 10) * 0.5;
    let row = rows.find((r) => Math.abs(r.y - y) < tolerance);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  rows.sort((a, b) => b.y - a.y); // PDF y grows upward — top of page first

  return rows
    .map((row) => {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let line = '';
      for (const item of row.items) {
        const col = Math.round((item.transform[4] - minX) / avgCharWidth);
        const padding = Math.max(line.length > 0 ? 1 : 0, col - line.length);
        line += ' '.repeat(padding) + item.str;
      }
      return line.replace(/\s+$/, '');
    })
    .join('\n');
}

/** Median per-character width across the page's text items, as a stand-in
 *  for "how wide is one monospace column" — the same heuristic pdftotext
 *  -layout uses, since PDFs don't otherwise expose a grid to snap to. */
function estimateCharWidth(items) {
  const widths = items
    .filter((it) => it.str.trim().length > 0 && it.width > 0)
    .map((it) => it.width / it.str.length)
    .sort((a, b) => a - b);
  if (widths.length === 0) return 6;
  return widths[Math.floor(widths.length / 2)];
}
