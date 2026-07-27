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
 *   value            string  — the raw chord line text
 *   onClick          fn      — called when user clicks to enter edit mode
 *   locked           bool    — if true, cursor changes to default and voicing editing is hidden
 *   customChords     object? — this song's own voicings, keyed by normalized chord name
 *   onSaveVoicing    fn?     — (chordName, voicing) => void — omit to disable voicing editing
 *   onResetVoicing   fn?     — (chordName) => void
 */
export default function ChordTokenDisplay({ value, onClick, locked, customChords, onSaveVoicing, onResetVoicing }) {
  const [hovered, setHovered] = useState(null); // { chordName, x, y }
  const [editingChord, setEditingChord] = useState(null); // chordName currently being edited, or null
  const hideTimeout = useRef(null);

  const showDiagram = useCallback((chordName, el) => {
    clearTimeout(hideTimeout.current);
    const rect = el.getBoundingClientRect();
    setHovered({
      chordName,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 6,
    });
    setEditingChord(null);
  }, []);

  const hideDiagram = useCallback(() => {
    hideTimeout.current = setTimeout(() => {
      // Don't dismiss the popup out from under an open voicing editor just
      // because the mouse wandered off it mid-edit — only Save/Cancel/Reset
      // (via onEditingChange) should close it while editing.
      setHovered((h) => (editingChord && h?.chordName === editingChord ? h : null));
    }, 80);
  }, [editingChord]);

  const tokens = tokenizeChordLine(value, customChords);

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
          // Chord-shaped — purple, hoverable (even without an exact CHORD_DB
          // voicing on file; ChordDiagram degrades gracefully for those)
          if (tok.looksLikeChord) {
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
          <ChordDiagram
            chordName={hovered.chordName}
            customChords={customChords}
            onSaveVoicing={onSaveVoicing}
            onResetVoicing={onResetVoicing}
            locked={locked}
            editing={editingChord === hovered.chordName}
            onEditingChange={(isEditing) => setEditingChord(isEditing ? hovered.chordName : null)}
          />
        </div>,
        document.body
      )}
    </>
  );
}
