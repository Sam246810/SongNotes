import React, { useRef, useEffect, useState } from 'react';
import ChordTokenDisplay from '../ChordTokenDisplay/ChordTokenDisplay';
import styles from './SongLine.module.css';

/**
 * SongLine — one row of the editor comprising a chord track and a lyric track.
 *
 * The chord track has two modes:
 *  - EDIT mode (input focused): shows a plain <input> for typing
 *  - DISPLAY mode (blurred): shows ChordTokenDisplay with hoverable chord diagrams
 *
 * Props:
 *   line         { id, chords, lyrics }
 *   locked       boolean — when true, inputs are read-only
 *   isActive     boolean — whether this line currently has focus
 *   focusTarget  'chords' | 'lyrics' | null — controlled focus from parent
 *   onFocused    (lineId, track) => void
 *   onChange     (lineId, { chords?, lyrics? }) => void
 *   onEnter      (lineId) => void
 *   onNavigate   (lineId, direction) => void  direction: 'up' | 'down' | 'chords' | 'lyrics'
 *   onDelete     (lineId) => void
 */
function getCharacterIndexFromClick(e, containerEl) {
  try {
    let range;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (e.rangeParent) {
      range = document.createRange();
      range.setStart(e.rangeParent, e.rangeOffset);
    }

    if (!range) return null;

    const textNode = range.startContainer;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;

    let offset = range.startOffset;
    let found = false;

    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node === textNode) {
        found = true;
        break;
      }
      offset += node.textContent.length;
    }

    return found ? offset : null;
  } catch (err) {
    console.warn('Failed to calculate caret index from click', err);
    return null;
  }
}

function getCharWidth(el) {
  try {
    const testSpan = document.createElement('span');
    const style = window.getComputedStyle(el);
    testSpan.style.font = style.font;
    testSpan.style.letterSpacing = style.letterSpacing;
    testSpan.style.visibility = 'hidden';
    testSpan.style.position = 'absolute';
    testSpan.style.whiteSpace = 'pre';
    testSpan.textContent = 'a';
    document.body.appendChild(testSpan);
    const width = testSpan.getBoundingClientRect().width;
    document.body.removeChild(testSpan);
    return width || 8;
  } catch {
    return 8;
  }
}

function getMaxChars(el) {
  // Use a stable max character limit (75 chars) so line breaks are consistent
  // and never fluctuate when side panels (DAW or Piano) are opened, expanded, or resized.
  return 75;
}


const SongLine = React.forwardRef(function SongLine(
  {
    line,
    locked,
    isActive,
    focusTarget,
    focusCaretIndex,
    onFocused,
    onChange,
    onEnter,
    onNavigate,
    onDelete,
    onSplit,
    onMergeWithPrevious,
  },
  _ref
) {

  const chordsRef = useRef(null);
  const lyricsRef = useRef(null);
  const [chordEditMode, setChordEditMode] = useState(false);
  const userTypedRef = useRef(false);

  // Controlled focus from parent
  useEffect(() => {
    if (focusTarget === 'chords' && chordsRef.current) {
      setChordEditMode(true);
      // Small delay so the input is rendered before we focus it
      setTimeout(() => {
        if (chordsRef.current) {
          chordsRef.current.focus();
          if (typeof focusCaretIndex === 'number') {
            chordsRef.current.setSelectionRange(focusCaretIndex, focusCaretIndex);
          }
        }
      }, 0);
    } else if (focusTarget === 'lyrics' && lyricsRef.current) {
      lyricsRef.current.focus();
      if (typeof focusCaretIndex === 'number') {
        lyricsRef.current.setSelectionRange(focusCaretIndex, focusCaretIndex);
      }
    }
  }, [focusTarget, focusCaretIndex]);

  // Overflow shifting (auto-split) based on stable character limit
  useEffect(() => {
    if (locked || !isActive || !userTypedRef.current) return;

    // Reset the typing flag so subsequent non-typing renders don't split
    userTypedRef.current = false;

    // Check lyric input overflow
    const lyricEl = lyricsRef.current;
    if (lyricEl) {
      const text = line.lyrics;
      const maxChars = getMaxChars(lyricEl);
      const overflows = text.length >= maxChars;

      if (overflows) {
        let splitIdx = text.lastIndexOf(' ', maxChars);
        if (splitIdx === -1 || splitIdx < maxChars / 2) {
          splitIdx = maxChars - 1;
        }

        if (splitIdx > 0 && splitIdx < text.length) {
          const caretIndex = lyricEl.selectionStart || 0;
          const newCaretIndex = Math.max(0, caretIndex - splitIdx);
          onSplit(line.id, splitIdx, 'lyrics', newCaretIndex);
          return; // Stop processing chords if lyrics overflowed
        }
      }
    }

    // Check chords input overflow
    const chordEl = chordsRef.current;
    if (chordEl && chordEditMode) {
      const text = line.chords;
      const maxChars = getMaxChars(chordEl);
      const overflows = text.length >= maxChars;

      if (overflows) {
        let splitIdx = text.lastIndexOf(' ', maxChars);
        if (splitIdx === -1 || splitIdx < maxChars / 2) {
          splitIdx = maxChars - 1;
        }

        if (splitIdx > 0 && splitIdx < text.length) {
          const caretIndex = chordEl.selectionStart || 0;
          const newCaretIndex = Math.max(0, caretIndex - splitIdx);
          onSplit(line.id, splitIdx, 'chords', newCaretIndex);
        }
      }
    }
  }, [line.lyrics, line.chords, isActive, chordEditMode, locked, onSplit]);


  const inputProps = {
    spellCheck: false,
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    readOnly: locked,
  };

  function handleKey(track, e) {
    if (locked) return;

    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;

    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter(line.id);
    } else if (e.key === 'ArrowUp') {
      if (track === 'lyrics') {
        e.preventDefault();
        onNavigate(line.id, 'chords');
      } else if (track === 'chords') {
        e.preventDefault();
        onNavigate(line.id, 'up');
      }
    } else if (e.key === 'ArrowDown') {
      if (track === 'chords') {
        e.preventDefault();
        onNavigate(line.id, 'lyrics');
      } else if (track === 'lyrics') {
        e.preventDefault();
        onNavigate(line.id, 'down');
      }
    } else if (e.key === 'Backspace' && atStart) {
      if (track === 'lyrics') {
        e.preventDefault();
        onMergeWithPrevious(line.id);
      } else if (track === 'chords') {
        const empty = line.chords.trim() === '' && line.lyrics.trim() === '';
        if (empty) {
          e.preventDefault();
          onDelete(line.id);
        }
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (track === 'lyrics') onNavigate(line.id, 'chords');
      else onNavigate(line.id, 'lyrics');
    }
  }

  function handleChordFocus() {
    setChordEditMode(true);
    onFocused(line.id, 'chords');
  }

  function handleChordBlur() {
    setChordEditMode(false);
  }

  const isEmpty = !line.chords.trim() && !line.lyrics.trim();

  return (
    <div
      className={`${styles.songLine} ${isActive ? styles.active : ''} ${locked ? styles.locked : ''} editor-song-line`}
      data-line-id={line.id}
    >
      {/* === Chord track === */}
      <div className={styles.trackRow}>
        <div className={styles.trackChord}>
          {/* Hidden-but-focusable input — always in DOM */}
          <input
            ref={chordsRef}
            className={`${styles.inputChord} ${chordEditMode ? styles.inputVisible : styles.inputHidden}`}
            type="text"
            value={line.chords}
            placeholder="Chords…"
            onChange={(e) => {
              userTypedRef.current = true;
              const caret = e.target.selectionStart;
              onChange(line.id, { chords: e.target.value });
              setTimeout(() => {
                if (chordsRef.current) {
                  chordsRef.current.setSelectionRange(caret, caret);
                }
              }, 0);
            }}
            onKeyDown={(e) => handleKey('chords', e)}
            onFocus={handleChordFocus}
            onBlur={handleChordBlur}
            aria-label="Chord input"
            {...inputProps}
          />
          {/* Token display — shown when not in edit mode */}
          {!chordEditMode && (
            <ChordTokenDisplay
              value={line.chords}
              locked={locked}
              onClick={(e) => {
                if (!locked) {
                  const clickedIndex = getCharacterIndexFromClick(e, e.currentTarget);
                  setChordEditMode(true);
                  setTimeout(() => {
                    if (chordsRef.current) {
                      chordsRef.current.focus();
                      if (clickedIndex !== null) {
                        chordsRef.current.setSelectionRange(clickedIndex, clickedIndex);
                      } else {
                        chordsRef.current.setSelectionRange(line.chords.length, line.chords.length);
                      }
                    }
                  }, 0);
                }
              }}
            />
          )}
        </div>
      </div>

      {/* === Lyric track === */}
      <div className={styles.trackRow}>
        <div className={styles.trackLyric}>
          <input
            ref={lyricsRef}
            className={styles.inputLyric}
            type="text"
            value={line.lyrics}
            placeholder={isActive ? 'Lyrics…' : ''}
            onChange={(e) => {
              userTypedRef.current = true;
              const caret = e.target.selectionStart;
              onChange(line.id, { lyrics: e.target.value });
              setTimeout(() => {
                if (lyricsRef.current) {
                  lyricsRef.current.setSelectionRange(caret, caret);
                }
              }, 0);
            }}
            onKeyDown={(e) => handleKey('lyrics', e)}
            onFocus={() => onFocused(line.id, 'lyrics')}
            aria-label="Lyric input"
            {...inputProps}
          />
        </div>
      </div>

      {isEmpty && !isActive && !locked && (
        <div className={styles.emptyHint}>↵ delete this line with Backspace</div>
      )}
    </div>
  );
});

export default SongLine;
