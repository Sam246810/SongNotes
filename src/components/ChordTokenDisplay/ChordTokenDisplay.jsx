import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { tokenizeChordLine } from '../../utils/chords';
import ChordDiagram from '../ChordDiagram/ChordDiagram';
import styles from './ChordTokenDisplay.module.css';

/**
 * ChordTokenDisplay
 * Renders a chord-track string as interactive tokens.
 * Recognized chord names get a styled span; hovering shows a ChordDiagram popup.
 *
 * Props:
 *   value    string  — the raw chord line text
 *   onClick  fn      — called when user clicks to enter edit mode
 *   locked   bool    — if true, cursor changes to default
 */
export default function ChordTokenDisplay({ value, onClick, locked }) {
  const [hovered, setHovered] = useState(null); // { chordName, x, y }
  const hideTimeout = useRef(null);

  const showDiagram = useCallback((chordName, el) => {
    clearTimeout(hideTimeout.current);
    const rect = el.getBoundingClientRect();
    setHovered({
      chordName,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 6,
    });
  }, []);

  const hideDiagram = useCallback(() => {
    hideTimeout.current = setTimeout(() => setHovered(null), 80);
  }, []);

  const tokens = tokenizeChordLine(value);

  // Render placeholder when empty
  if (tokens.length === 0 || !value.trim()) {
    return (
      <div
        className={`${styles.display} ${locked ? styles.locked : ''}`}
        onClick={locked ? undefined : onClick}
      >
        <span className={styles.placeholder} />
      </div>
    );
  }

  return (
    <>
      <div
        className={`${styles.display} ${locked ? styles.locked : ''}`}
        onClick={locked ? undefined : onClick}
      >
        {tokens.map((tok, i) => {
          // Pure whitespace — transparent spacer
          if (tok.isWhitespace) {
            return <span key={i} className={styles.space}>{tok.text}</span>;
          }
          // Known chord — purple, hoverable
          if (tok.isChord) {
            return (
              <span
                key={i}
                className={styles.chord}
                onMouseEnter={(e) => showDiagram(tok.chordName, e.currentTarget)}
                onMouseLeave={hideDiagram}
              >
                {tok.text}
              </span>
            );
          }
          // Unrecognized word — dimmed but visible, hoverable with 'no chart' popup
          return (
            <span
              key={i}
              className={styles.unknown}
              onMouseEnter={(e) => showDiagram(tok.chordName, e.currentTarget)}
              onMouseLeave={hideDiagram}
            >
              {tok.text}
            </span>
          );
        })}
      </div>

      {hovered && createPortal(
        <div
          className={styles.popupAnchor}
          style={{ left: hovered.x, top: hovered.y }}
          onMouseEnter={() => clearTimeout(hideTimeout.current)}
          onMouseLeave={hideDiagram}
        >
          <ChordDiagram chordName={hovered.chordName} />
        </div>,
        document.body
      )}
    </>
  );
}
