import { useEffect, useState } from 'react';

// Chords sit above lyrics by character column, so both tracks must share one
// glyph width or a chord drifts off its word further along the line (chords
// used to be monospace over proportional lyrics, and did). Both are monospace
// now; the chords, a size smaller and bold, get exactly the letter spacing
// that makes up the difference -- measured rather than assumed, since which
// font in the stack actually renders varies by machine. Same scheme as the
// Android editor (SongEditorScreen.kt).
const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Courier New', monospace";
export const LYRIC_FONT = `400 15px ${MONO_STACK}`;
export const CHORD_FONT = `700 14px ${MONO_STACK}`;

// Used until (or if) the browser can measure: 0.6em is the advance of most
// monospace fonts, and equal-looking spacing beats none at all.
const FALLBACK = { glyphWidth: 9, chordLetterSpacing: 0.6 };

let canvas = null;

function advance(ctx, font) {
  ctx.font = font;
  return ctx.measureText('M'.repeat(100)).width / 100;
}

function measure() {
  try {
    canvas = canvas || document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return FALLBACK;
    const glyphWidth = advance(ctx, LYRIC_FONT);
    if (!(glyphWidth > 0)) return FALLBACK;
    return { glyphWidth, chordLetterSpacing: glyphWidth - advance(ctx, CHORD_FONT) };
  } catch {
    return FALLBACK;
  }
}

/**
 * `{ glyphWidth, chordLetterSpacing }` in CSS px: the advance of one lyric
 * character, and the letter spacing that gives a chord character that same
 * advance. Re-measured once the web fonts finish loading, since until then
 * the canvas measures a fallback font.
 */
export default function useLyricMetrics() {
  const [metrics, setMetrics] = useState(measure);

  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return undefined;
    let cancelled = false;
    const update = () => {
      if (cancelled) return;
      const next = measure();
      setMetrics((prev) => (
        prev.glyphWidth === next.glyphWidth && prev.chordLetterSpacing === next.chordLetterSpacing ? prev : next
      ));
    };
    Promise.all([fonts.load(LYRIC_FONT), fonts.load(CHORD_FONT)]).then(update, update);
    fonts.addEventListener?.('loadingdone', update);
    return () => {
      cancelled = true;
      fonts.removeEventListener?.('loadingdone', update);
    };
  }, []);

  return metrics;
}
