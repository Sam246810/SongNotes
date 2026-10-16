import React, { useLayoutEffect, useRef, useState } from 'react';
import ChordTokenDisplay from '../ChordTokenDisplay/ChordTokenDisplay';
import {
  rowStarts, rowOfOffset, layoutParagraph, replaceRowChords, editLyrics, splitParagraph, insertText,
  capChordInput, charLengthBefore, charLengthAt,
} from '../../utils/paragraphEditing';
import styles from './SongLine.module.css';

/**
 * SongLine — one saved line of a song: a paragraph, however long, drawn as
 * rows that soft-wrap to the editor's width. Each row is a chord track over a
 * lyric track. Wrapping is display-only (see utils/paragraphEditing.js): the
 * rows are cut afresh from the paragraph on every render, so words flow
 * between rows as you type or delete, and the line is saved whole.
 *
 * Editing follows a normal text editor (and the Android app):
 *  - Typing past the edge moves the word down whole; the space before it
 *    hangs at the end of the row above.
 *  - Typing the space after a word that exactly fills its row moves the caret
 *    to a fresh empty row, which lasts only while the caret is on it.
 *  - Backspace at the start of a wrapped row deletes the character before it
 *    (normally the hanging space); at the start of the line it asks the
 *    parent to join this line onto the previous one.
 *  - Enter splits the line at the caret into two lines.
 *
 * Each row's chord track has two modes:
 *  - EDIT mode (input focused): a plain <input>, hard-capped at `columns`
 *    characters so it never scrolls sideways or spills onto another row.
 *  - DISPLAY mode (blurred): ChordTokenDisplay with hoverable chord diagrams.
 *
 * Props:
 *   line          { id, lyrics, chords: [{ i, c }] }
 *   isFirst       boolean — the song's first line (backspace at its start does nothing)
 *   columns       number  — how many monospace characters fit across a row
 *   glyphWidth    number  — the advance of one character, in px
 *   locked        boolean — when true, inputs are read-only
 *   focusRequest  { seq, track: 'lyrics'|'chords', offset?, row?: number|'first'|'last', column? } | null
 *                 — where the parent wants the caret, for this line only: a
 *                   paragraph offset, or a row and column
 *   onFocusApplied   (seq) => void
 *   onRequestFocus   (request) => void — asks the parent to place the caret (request has a lineId)
 *   onReplaceLine    (lineId, newLines, focusRequest?) => void — this line becomes `newLines`
 *   onJoinWithPrevious (lineId) => void
 *   onJoinWithNext     (lineId) => void
 *   onNavigate       (lineId, 'prev'|'next', track, column) => void — caret leaves this line
 *   customChords     object? — this song's own voicings, keyed by normalized chord name
 *   onSaveVoicing    fn?     — (chordName, voicing) => void — omit to disable voicing editing
 *   onResetVoicing   fn?     — (chordName) => void
 */
function SongLine({
  line,
  isFirst,
  columns,
  glyphWidth,
  locked,
  focusRequest,
  onFocusApplied,
  onRequestFocus,
  onReplaceLine,
  onJoinWithPrevious,
  onJoinWithNext,
  onNavigate,
  customChords,
  onSaveVoicing,
  onResetVoicing,
}) {
  const containerRef = useRef(null);
  const lyricRefs = useRef([]);
  const chordRefs = useRef([]);
  // Paragraph offset of the lyric caret while it's in this line, else null.
  const [caret, setCaret] = useState(null);
  // The chord row being edited: { row, text, key, caret }. `text` keeps what
  // was typed (alignment spaces included) while `key` still matches the line
  // it was typed into; `caret`, when set, is still to be applied.
  const [chordEdit, setChordEdit] = useState(null);
  // While an IME composes a word, the rows stay cut where they were (the
  // composing row just grows) — moving text out from under a composition
  // would break it. Re-wrapped when the composition ends.
  const [frozen, setFrozen] = useState(null);

  const lyrics = line.lyrics;

  // A row and column from the parent resolve to an offset against the rows as
  // they stand; an explicit offset is used as is.
  const baseStarts = rowStarts(lyrics, columns);
  const requestedOffset = focusRequest?.track === 'lyrics'
    ? (typeof focusRequest.offset === 'number'
      ? focusRequest.offset
      : offsetAt(lyrics, baseStarts, resolveRow(baseStarts, focusRequest.row), focusRequest.column))
    : null;
  const caretOffset = requestedOffset ?? caret;
  const starts = frozen
    ? frozen.starts.map((s, k) => (k > frozen.row ? s + lyrics.length - frozen.length : s))
    : rowStarts(lyrics, columns, caretOffset !== null && caretOffset >= lyrics.length);
  const rows = layoutParagraph(line, starts, columns);
  const lastRow = rows.length - 1;
  const chordsKey = JSON.stringify([line.chords, starts]);

  // The chords-track text of row k: what's being typed into it, unless the
  // line has since changed under it (then the draft is stale).
  function chordText(k) {
    return chordEdit && chordEdit.row === k && chordEdit.key === chordsKey ? chordEdit.text : rows[k].chords;
  }

  function startChordEdit(k, column) {
    const text = rows[k].chords;
    const col = Math.min(Math.max(column, 0), columns);
    // Pad out to the clicked column, so the caret lands where the click did
    // even past the last chord. Trailing spaces never become chords.
    setChordEdit({ row: k, text: text.padEnd(col), key: chordsKey, caret: col });
  }

  // Apply a caret placement requested by the parent.
  useLayoutEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.track === 'chords') {
      const k = resolveRow(starts, focusRequest.row);
      startChordEdit(k, focusRequest.column ?? 0);
    } else {
      const k = rowOfOffset(starts, requestedOffset);
      const el = lyricRefs.current[k];
      if (el) {
        const local = requestedOffset - starts[k];
        if (document.activeElement !== el) el.focus();
        el.setSelectionRange(local, local);
      }
      setCaret(requestedOffset);
    }
    onFocusApplied(focusRequest.seq);
    // Runs once per request; `starts`/`requestedOffset` are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Apply a chord-row caret placement (from a click, a key, or the parent).
  useLayoutEffect(() => {
    if (chordEdit?.caret == null) return;
    const el = chordRefs.current[chordEdit.row];
    if (el) {
      if (document.activeElement !== el) el.focus();
      el.setSelectionRange(chordEdit.caret, chordEdit.caret);
    }
    setChordEdit((ce) => (ce ? { ...ce, caret: null } : ce));
  }, [chordEdit]);

  // --- Lyrics ---

  function rowEnd(k) {
    return k < lastRow ? starts[k + 1] : lyrics.length;
  }

  function focusOffset(offset) {
    onRequestFocus({ lineId: line.id, track: 'lyrics', offset });
  }

  function handleLyricsChange(k, e) {
    const el = e.target;
    const newLyrics = lyrics.slice(0, starts[k]) + el.value + lyrics.slice(rowEnd(k));
    const offset = starts[k] + el.selectionStart;
    const edited = editLyrics(line, newLyrics, offset);
    if (frozen || e.nativeEvent.isComposing) {
      if (!frozen) setFrozen({ starts, row: k, length: lyrics.length });
      setCaret(offset);
      onReplaceLine(line.id, [edited]);
    } else {
      onReplaceLine(line.id, [edited], { lineId: line.id, track: 'lyrics', offset });
    }
  }

  function handleCompositionStart(k) {
    setFrozen({ starts, row: k, length: lyrics.length });
  }

  function handleCompositionEnd(k, e) {
    setFrozen(null);
    focusOffset(starts[k] + e.target.selectionStart);
  }

  function deleteRange(from, to, focusAt) {
    const newLyrics = lyrics.slice(0, from) + lyrics.slice(to);
    onReplaceLine(line.id, [editLyrics(line, newLyrics, from)], { lineId: line.id, track: 'lyrics', offset: focusAt });
  }

  function handleLyricsKey(k, e) {
    if (locked) return;
    const el = e.currentTarget;
    const { selectionStart: selStart, selectionEnd: selEnd, value } = el;
    const collapsed = selStart === selEnd;
    const offset = starts[k] + selStart;
    // The furthest the caret goes on a row: before the space a wrap hung at
    // its end, since after it is the start of the next row.
    const maxLocal = k < lastRow && value.endsWith(' ') ? value.length - 1 : value.length;

    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = editLyrics(line, lyrics.slice(0, offset) + lyrics.slice(starts[k] + selEnd), offset);
      const [before, after] = splitParagraph(trimmed, offset);
      onReplaceLine(line.id, [before, after], { lineId: after.id, track: 'lyrics', offset: 0 });
    } else if (e.key === 'Backspace' && collapsed && selStart === 0) {
      e.preventDefault();
      if (k > 0) {
        // A wrapped row's start is the same spot as the end of the row above:
        // delete the character before it (normally the hanging space).
        const del = charLengthBefore(lyrics, offset);
        deleteRange(offset - del, offset, offset - del);
      } else if (!isFirst) {
        onJoinWithPrevious(line.id);
      }
    } else if (e.key === 'Delete' && collapsed && selStart === value.length) {
      e.preventDefault();
      if (k < lastRow) deleteRange(offset, offset + charLengthAt(lyrics, offset), offset);
      else onJoinWithNext(line.id);
    } else if (e.key === 'ArrowLeft' && collapsed && selStart === 0 && !e.shiftKey) {
      e.preventDefault();
      if (k > 0) focusOffset(offset - charLengthBefore(lyrics, offset));
      else onNavigate(line.id, 'prev', 'lyrics', Infinity);
    } else if (e.key === 'ArrowRight' && collapsed && selStart >= maxLocal && !e.shiftKey) {
      e.preventDefault();
      if (k < lastRow) focusOffset(offset + charLengthAt(lyrics, offset));
      else onNavigate(line.id, 'next', 'lyrics', 0);
    } else if (e.key === 'ArrowUp' || e.key === 'Tab') {
      e.preventDefault();
      startChordEdit(k, selStart);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (k < lastRow) focusOffset(offsetAt(lyrics, starts, k + 1, selStart));
      else onNavigate(line.id, 'next', 'lyrics', selStart);
    }
  }

  function handleLyricsSelect(k, e) {
    const el = e.target;
    // A click past the end of a row that wraps lands before its hanging space,
    // as in any text editor: after it is the next row's first word, and
    // typing there would glue onto that word.
    if (k < lastRow && el.selectionStart === el.selectionEnd &&
      el.selectionStart === el.value.length && el.value.endsWith(' ')) {
      el.setSelectionRange(el.value.length - 1, el.value.length - 1);
    }
    setCaret(starts[k] + el.selectionStart);
  }

  function handleLyricsPaste(k, e) {
    if (locked) return;
    e.preventDefault();
    const el = e.currentTarget;
    const text = e.clipboardData.getData('text');
    const { paragraphs, caret: [pk, at] } = insertText(line, starts[k] + el.selectionStart, starts[k] + el.selectionEnd, text);
    onReplaceLine(line.id, paragraphs, { lineId: paragraphs[pk].id, track: 'lyrics', offset: at });
  }

  // --- Chords ---

  function handleChordsChange(k, e) {
    const el = e.target;
    const accepted = capChordInput(chordText(k), el.value, el.selectionStart, columns);
    if (!accepted) return; // React puts the old value back
    const chords = replaceRowChords(line, starts, k, accepted.text);
    // Keyed to the line as it will be after this edit, so the draft survives it.
    const key = JSON.stringify([chords, starts]);
    // When the cap changed the text (a full row gives up a padding space for
    // each letter typed), React writes the new value into the input, which
    // puts the browser's caret at the end -- so put it back after the letter.
    const unchanged = accepted.text === el.value && accepted.caret === el.selectionStart;
    setChordEdit({ row: k, text: accepted.text, key, caret: unchanged ? null : accepted.caret });
    onReplaceLine(line.id, [{ ...line, chords }]);
  }

  function handleChordsKey(k, e) {
    if (locked) return;
    const column = e.currentTarget.selectionStart;
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();
      onRequestFocus({ lineId: line.id, track: 'lyrics', row: k, column });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (k > 0) onRequestFocus({ lineId: line.id, track: 'lyrics', row: k - 1, column });
      else onNavigate(line.id, 'prev', 'lyrics', column);
    }
    // Backspace at column 0 deliberately does nothing: a chord row never
    // joins anything.
  }

  function handleChordsFocus(k) {
    if (chordEdit?.row !== k) setChordEdit({ row: k, text: rows[k].chords, key: chordsKey, caret: null });
    // The lyric caret has left — unless this is the chord track of the empty
    // row the caret opened, which would vanish with it.
    if (!(k === lastRow && caretOffset !== null && caretOffset >= lyrics.length)) setCaret(null);
  }

  function handleChordDisplayClick(k, e) {
    if (locked) return;
    const el = e.currentTarget;
    const left = el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft || '0');
    startChordEdit(k, Math.round((e.clientX - left) / glyphWidth));
  }

  function handleBlur(e) {
    if (containerRef.current?.contains(e.relatedTarget)) return;
    setCaret(null);
    setChordEdit(null);
    setFrozen(null);
  }

  const inputProps = {
    spellCheck: false,
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    readOnly: locked,
  };

  const isActive = caret !== null || chordEdit !== null;
  const isEmpty = !lyrics.trim() && line.chords.length === 0;

  return (
    <div
      ref={containerRef}
      className={`${styles.songLine} ${isActive ? styles.active : ''} ${locked ? styles.locked : ''}`}
      data-line-id={line.id}
      onBlur={handleBlur}
    >
      {rows.map((row, k) => {
        const editingChords = chordEdit?.row === k;
        return (
          <div key={k}>
            {/* === Chord track === */}
            <div className={styles.trackRow}>
              <div className={styles.trackChord}>
                {/* Hidden-but-focusable input — always in DOM */}
                <input
                  ref={(el) => { chordRefs.current[k] = el; }}
                  className={`${styles.inputChord} ${editingChords ? styles.inputVisible : styles.inputHidden}`}
                  type="text"
                  value={chordText(k)}
                  // A wrapped row is the rest of the line above, not a line
                  // of its own to prompt for.
                  placeholder={k === 0 ? 'Chords…' : ''}
                  onChange={(e) => handleChordsChange(k, e)}
                  onKeyDown={(e) => handleChordsKey(k, e)}
                  onFocus={() => handleChordsFocus(k)}
                  aria-label="Chord input"
                  {...inputProps}
                />
                {!editingChords && (
                  <ChordTokenDisplay
                    value={row.chords}
                    locked={locked}
                    customChords={customChords}
                    onSaveVoicing={onSaveVoicing}
                    onResetVoicing={onResetVoicing}
                    onClick={(e) => handleChordDisplayClick(k, e)}
                  />
                )}
              </div>
            </div>

            {/* === Lyric track === */}
            <div className={styles.trackRow}>
              <div className={styles.trackLyric}>
                <input
                  ref={(el) => { lyricRefs.current[k] = el; }}
                  className={styles.inputLyric}
                  type="text"
                  value={row.lyrics}
                  placeholder={k === 0 && isActive ? 'Lyrics…' : ''}
                  onChange={(e) => handleLyricsChange(k, e)}
                  onKeyDown={(e) => handleLyricsKey(k, e)}
                  onSelect={(e) => handleLyricsSelect(k, e)}
                  onFocus={(e) => { setChordEdit(null); setCaret(starts[k] + e.target.selectionStart); }}
                  onPaste={(e) => handleLyricsPaste(k, e)}
                  onCompositionStart={() => handleCompositionStart(k)}
                  onCompositionEnd={(e) => handleCompositionEnd(k, e)}
                  aria-label="Lyric input"
                  {...inputProps}
                />
              </div>
            </div>
          </div>
        );
      })}

      {isEmpty && !isActive && !locked && !isFirst && (
        <div className={styles.emptyHint}>⌫ Backspace at the start of an empty line deletes it</div>
      )}
    </div>
  );
}

/** Row index for a row given as a number, 'first' or 'last'. */
function resolveRow(starts, row) {
  if (row === 'last') return starts.length - 1;
  if (typeof row !== 'number') return 0;
  return Math.min(Math.max(row, 0), starts.length - 1);
}

/**
 * The paragraph offset at `column` of row `k`, clamped to the row — and to
 * before the space a wrap hung at its end, which belongs to the next row.
 */
function offsetAt(text, starts, k, column) {
  const start = starts[k];
  const end = k < starts.length - 1 ? starts[k + 1] : text.length;
  const maxLocal = k < starts.length - 1 && text[end - 1] === ' ' ? end - start - 1 : end - start;
  return start + Math.min(Math.max(column, 0), maxLocal);
}

export default React.memo(SongLine);
