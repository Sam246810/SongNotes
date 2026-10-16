import { createPortal } from 'react-dom';
import { wrapSongToColumns } from '../../utils/lineWrap';
import { renderChordAnchors } from '../../utils/paragraphEditing';
import styles from './PrintSheet.module.css';

/**
 * Columns a printed line wraps to. Lyrics and chords print in one monospace
 * size (11pt), so 70 columns is about 6.4in at the usual 0.6em glyph width:
 * inside the printable width of both US Letter and A4 with the browser's
 * default margins.
 */
const PRINT_COLUMNS = 70;

/**
 * What "Export as PDF" (window.print()) actually prints: the song wrapped to
 * the page like the Android app's PDF export -- each line cut into rows by
 * `wrapSongToColumns`, chords over their words (two that would touch are
 * moved apart rather than printed as one), and a title that wraps instead of
 * running off the page. Hidden on screen; the @media print rules in
 * global.css show it in place of the app. Rendered into <body>, outside the
 * app's fixed-height scrolling layout, so a long song runs onto more pages.
 */
export default function PrintSheet({ song }) {
  const meta = [['BPM', song.bpm], ['Key', song.key], ['Tuning', song.tuning], ['Capo', song.capo]]
    .filter(([, value]) => value);
  const lines = wrapSongToColumns(song, PRINT_COLUMNS).lines;

  return createPortal(
    <div className={`${styles.sheet} print-sheet`}>
      <h1 className={styles.title}>{song.title || 'Untitled'}</h1>
      {meta.length > 0 && (
        <p className={styles.meta}>{meta.map(([label, value]) => `${label}: ${value}`).join('   ·   ')}</p>
      )}
      {lines.map((line, i) => {
        const chords = renderChordAnchors(line.chords, 0);
        const hasChords = chords.trim().length > 0;
        const hasLyrics = line.lyrics.trim().length > 0;
        if (!hasChords && !hasLyrics) return <div key={i} className={styles.blank} />;
        return (
          <div key={i} className={styles.entry}>
            {hasChords && <div className={styles.chords}>{chords}</div>}
            {hasLyrics && <div className={styles.lyrics}>{line.lyrics}</div>}
          </div>
        );
      })}
    </div>,
    document.body
  );
}
