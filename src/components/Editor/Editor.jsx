import { useState, useCallback, useLayoutEffect } from 'react';
import useSongsStore from '../../store/songsStore';
import useAuth from '../../auth/useAuth';
import SongLine from '../SongLine/SongLine';
import useLyricMetrics, { LYRIC_FONT, CHORD_FONT } from '../SongLine/useLyricMetrics';
import { joinParagraphs } from '../../utils/paragraphEditing';
import SongMetaBar from './SongMetaBar';
import PrintSheet from './PrintSheet';
import Toolbar from '../Toolbar/Toolbar';
import PianoPanel from '../PianoPanel/PianoPanel';
import DAWPanel from '../DAWPanel/DAWPanel';
import styles from './Editor.module.css';

/**
 * Shown instead of the editor for an encrypted song when the account encryption key
 * isn't unlocked in this session — e.g. the browser was closed and reopened, so the
 * Supabase auth session (persisted in localStorage) survived but the DEK cached in
 * sessionStorage didn't.
 */
function AccountKeyGate() {
  const { unlockAccountKey } = useAuth();
  const hydrate = useSongsStore((s) => s.hydrate);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await unlockAccountKey(password);
      // Re-fetch: this unlocks every DEK-only song affected this session, not just
      // the one currently open.
      await hydrate();
    } catch (err) {
      setError(err.message || 'Incorrect password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>🔒</div>
      <p>Enter your password to view this song.</p>
      <form className={styles.unlockForm} onSubmit={handleSubmit}>
        <input
          type="password"
          className={styles.unlockInput}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          required
          autoComplete="current-password"
        />
        <button type="submit" className={styles.unlockBtn} disabled={submitting} id="account-key-unlock-btn">
          {submitting ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      {error && <p className={styles.unlockError}>{error}</p>}
    </div>
  );
}

// Room left at a row's right edge for the caret, so a row exactly at
// capacity never scrolls its input sideways by the caret's width.
const CARET_SLACK_PX = 2;

/** The song's lines as the store holds them right now (handlers run between renders). */
function currentLines(songId) {
  return useSongsStore.getState().songs.find((s) => s.id === songId)?.lines ?? [];
}

/**
 * Editor — full song editing view.
 * Each song line is a paragraph that SongLine wraps to the width measured
 * here. Coordinates the caret across lines (a focus request names the line
 * and where in it) and delegates all store mutations to songsStore.
 */
export default function Editor() {
  const {
    songs, activeSongId, replaceLines, updateSongMeta, transposeSong, setCustomChord, removeCustomChord,
  } = useSongsStore();
  const song = songs.find((s) => s.id === activeSongId) ?? null;
  const songId = song?.id;

  const [showScratchpad, setShowScratchpad] = useState(false);
  const [showPiano, setShowPiano] = useState(true);
  const [showDaw, setShowDaw] = useState(true);

  const handleToggleScratchpad = useCallback(() => {
    setShowScratchpad((prev) => {
      if (!prev) {
        setShowPiano(true);
        setShowDaw(true);
        return true;
      }
      return false;
    });
  }, []);

  // How many characters fit across a row: the row's text width (measured off
  // an empty stand-in with a row's padding) over one monospace glyph.
  const { glyphWidth, chordLetterSpacing } = useLyricMetrics();
  const [measureEl, setMeasureEl] = useState(null);
  const [rowWidth, setRowWidth] = useState(0);
  // Measured once as it mounts, not left to the ResizeObserver's first report:
  // a browser delivers those only when it renders a frame, which it doesn't
  // for a tab in the background, and the lines would sit unwrapped until then.
  const measureRef = useCallback((el) => {
    setMeasureEl(el);
    if (el) setRowWidth(el.getBoundingClientRect().width);
  }, []);
  useLayoutEffect(() => {
    if (!measureEl || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setRowWidth(entry.contentRect.width));
    observer.observe(measureEl);
    return () => observer.disconnect();
  }, [measureEl]);
  // Unwrapped until there's a width to wrap to.
  const columns = rowWidth > 0 ? Math.max(1, Math.floor((rowWidth - CARET_SLACK_PX) / glyphWidth)) : Infinity;

  // Where the caret should go next: { seq, lineId, track, offset? | row, column }.
  const [focusRequest, setFocusRequest] = useState(null);
  const requestFocus = useCallback((request) => {
    setFocusRequest((prev) => ({ ...request, seq: (prev?.seq ?? 0) + 1 }));
  }, []);
  const handleFocusApplied = useCallback((seq) => {
    setFocusRequest((prev) => (prev?.seq === seq ? null : prev));
  }, []);

  const handleReplaceLine = useCallback(
    (lineId, newLines, focus) => {
      const idx = currentLines(songId).findIndex((l) => l.id === lineId);
      if (idx === -1) return;
      replaceLines(songId, idx, 1, newLines);
      if (focus) requestFocus(focus);
    },
    [songId, replaceLines, requestFocus]
  );

  // Backspace at the start of a line: it joins onto the end of the line above.
  const handleJoinWithPrevious = useCallback(
    (lineId) => {
      const lines = currentLines(songId);
      const idx = lines.findIndex((l) => l.id === lineId);
      if (idx <= 0) return;
      const above = lines[idx - 1];
      replaceLines(songId, idx - 1, 2, [joinParagraphs(above, lines[idx])]);
      requestFocus({ lineId: above.id, track: 'lyrics', offset: above.lyrics.length });
    },
    [songId, replaceLines, requestFocus]
  );

  // Delete at the end of a line: the line below joins onto it.
  const handleJoinWithNext = useCallback(
    (lineId) => {
      const lines = currentLines(songId);
      const idx = lines.findIndex((l) => l.id === lineId);
      if (idx === -1 || idx === lines.length - 1) return;
      const line = lines[idx];
      replaceLines(songId, idx, 2, [joinParagraphs(line, lines[idx + 1])]);
      requestFocus({ lineId: line.id, track: 'lyrics', offset: line.lyrics.length });
    },
    [songId, replaceLines, requestFocus]
  );

  // The caret leaves a line: into the last row of the line above, or the
  // first row of the line below, at `column`.
  const handleNavigate = useCallback(
    (lineId, direction, track, column) => {
      const lines = currentLines(songId);
      const idx = lines.findIndex((l) => l.id === lineId);
      const target = lines[direction === 'prev' ? idx - 1 : idx + 1];
      if (idx === -1 || !target) return;
      requestFocus({ lineId: target.id, track, row: direction === 'prev' ? 'last' : 'first', column });
    },
    [songId, requestFocus]
  );

  const handleUpdateMeta = useCallback(
    (changes) => {
      if (!song) return;
      updateSongMeta(song.id, changes);
    },
    [song, updateSongMeta]
  );

  const handleTranspose = useCallback(
    (semitones) => {
      if (!song) return;
      transposeSong(song.id, semitones);
    },
    [song, transposeSong]
  );

  // Keyed on the id alone (like the line handlers above) so typing, which
  // changes `song` on every keystroke, doesn't re-render every SongLine.
  const handleSaveVoicing = useCallback(
    (chordName, voicing) => {
      if (songId) setCustomChord(songId, chordName, voicing);
    },
    [songId, setCustomChord]
  );

  const handleResetVoicing = useCallback(
    (chordName) => {
      if (songId) removeCustomChord(songId, chordName);
    },
    [songId, removeCustomChord]
  );


  if (!song) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>♪</div>
        <p>Select a song or create a new one to get started.</p>
      </div>
    );
  }

  // An undecryptable song has no real content to show (see repository placeholders)
  // — gate before rendering the normal editor, rather than merely treating it as
  // read-only. There's only one reason a song can be undecryptable now: the account
  // DEK isn't unlocked in this session.
  if (song.isUndecryptedPlaceholder) {
    return <AccountKeyGate />;
  }

  return (
    <div className={styles.editorWrapper}>
      <Toolbar
        song={song}
        showScratchpad={showScratchpad}
        onToggleScratchpad={handleToggleScratchpad}
      />
      <div className={`${styles.editorBody} ${showScratchpad ? styles.hasScratchpad : ''}`}>
        <div className={styles.editorScroll}>
          <div
            className={styles.linesContainer}
            style={{
              '--lyric-font': LYRIC_FONT,
              '--chord-font': CHORD_FONT,
              '--chord-letter-spacing': `${chordLetterSpacing}px`,
            }}
          >
            <SongMetaBar song={song} onUpdateMeta={handleUpdateMeta} onTranspose={handleTranspose} />
            <div ref={measureRef} className={styles.rowMeasure} aria-hidden="true" />
            {song.lines.map((line, index) => (
              <SongLine
                key={line.id}
                line={line}
                isFirst={index === 0}
                columns={columns}
                glyphWidth={glyphWidth}
                locked={false}
                focusRequest={focusRequest?.lineId === line.id ? focusRequest : null}
                onFocusApplied={handleFocusApplied}
                onRequestFocus={requestFocus}
                onReplaceLine={handleReplaceLine}
                onJoinWithPrevious={handleJoinWithPrevious}
                onJoinWithNext={handleJoinWithNext}
                onNavigate={handleNavigate}
                customChords={song.customChords}
                onSaveVoicing={handleSaveVoicing}
                onResetVoicing={handleResetVoicing}
              />
            ))}
          </div>
        </div>
        {showScratchpad && (
          <DAWPanel
            key={song.id}
            songId={song.id}
            showPiano={showPiano}
            onTogglePiano={() => setShowPiano((p) => !p)}
            showDaw={showDaw}
            onToggleDaw={() => setShowDaw((d) => !d)}
          />
        )}
      </div>
      <PrintSheet song={song} />
    </div>
  );
}
