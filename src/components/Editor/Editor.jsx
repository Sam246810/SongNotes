import { useState, useCallback } from 'react';
import useSongsStore from '../../store/songsStore';
import SongLine from '../SongLine/SongLine';
import Toolbar from '../Toolbar/Toolbar';
import PianoPanel from '../PianoPanel/PianoPanel';
import DAWPanel from '../DAWPanel/DAWPanel';
import styles from './Editor.module.css';

/** Shown instead of the editor for a password-locked song not yet unlocked this session. */
function SongPasswordGate({ song }) {
  const unlockSong = useSongsStore((s) => s.unlockSong);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await unlockSong(song.id, password);
    } catch (err) {
      setError(err.message || 'Wrong password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>🔒</div>
      <p>This song is password-protected.</p>
      <form className={styles.unlockForm} onSubmit={handleSubmit}>
        <input
          type="password"
          className={styles.unlockInput}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Song password"
          autoFocus
          required
        />
        <button type="submit" className={styles.unlockBtn} disabled={submitting} id="song-password-unlock-btn">
          {submitting ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      {error && <p className={styles.unlockError}>{error}</p>}
    </div>
  );
}

/**
 * Editor — full song editing view.
 * Manages focus state and delegates all store mutations to songsStore.
 */
export default function Editor({ sidebarOpen, onToggleSidebar }) {
  const { songs, activeSongId, updateLine, addLineAfter, deleteLine, splitLine, mergeLineWithPrevious } = useSongsStore();
  const song = songs.find((s) => s.id === activeSongId) ?? null;

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

  // focusState: { lineId: string, track: 'chords' | 'lyrics' } | null
  const [focusState, setFocusState] = useState(null);
  // pendingFocus: after adding/deleting we control where focus goes next
  const [pendingFocus, setPendingFocus] = useState(null);

  const handleFocused = useCallback((lineId, track) => {
    setFocusState({ lineId, track });
    setPendingFocus(null);
  }, []);

  const handleChange = useCallback(
    (lineId, changes) => {
      if (!song) return;
      updateLine(song.id, lineId, changes);
    },
    [song, updateLine]
  );

  const handleEnter = useCallback(
    (lineId) => {
      if (!song) return;
      const newId = addLineAfter(song.id, lineId);
      setPendingFocus({ lineId: newId, track: 'lyrics' });
    },
    [song, addLineAfter]
  );

  const handleNavigate = useCallback(
    (lineId, direction) => {
      if (!song) return;
      const idx = song.lines.findIndex((l) => l.id === lineId);

      if (direction === 'chords') {
        setPendingFocus({ lineId, track: 'chords' });
      } else if (direction === 'lyrics') {
        setPendingFocus({ lineId, track: 'lyrics' });
      } else if (direction === 'up') {
        if (idx > 0) {
          setPendingFocus({ lineId: song.lines[idx - 1].id, track: 'lyrics' });
        }
      } else if (direction === 'down') {
        if (idx < song.lines.length - 1) {
          setPendingFocus({ lineId: song.lines[idx + 1].id, track: 'lyrics' });
        }
      }
    },
    [song]
  );

  const handleDelete = useCallback(
    (lineId) => {
      if (!song) return;
      const idx = song.lines.findIndex((l) => l.id === lineId);
      deleteLine(song.id, lineId);
      // Focus previous line lyrics, or first line
      const prevIdx = Math.max(0, idx - 1);
      const targetLine = song.lines[prevIdx];
      if (targetLine && targetLine.id !== lineId) {
        setPendingFocus({ lineId: targetLine.id, track: 'lyrics' });
      } else if (song.lines.length > 1) {
        const nextLine = song.lines.find((l) => l.id !== lineId);
        if (nextLine) setPendingFocus({ lineId: nextLine.id, track: 'lyrics' });
      }
    },
    [song, deleteLine]
  );

  const handleSplit = useCallback(
    (lineId, splitIndex, track, caretIndex) => {
      if (!song) return;
      const targetFocus = splitLine(song.id, lineId, splitIndex, track, caretIndex);
      if (targetFocus) {
        setPendingFocus(targetFocus);
      }
    },
    [song, splitLine]
  );

  const handleMergeWithPrevious = useCallback(
    (lineId) => {
      if (!song) return;
      const targetFocus = mergeLineWithPrevious(song.id, lineId);
      if (targetFocus) {
        setPendingFocus(targetFocus);
      }
    },
    [song, mergeLineWithPrevious]
  );


  if (!song) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyIcon}>♪</div>
        <p>Select a song or create a new one to get started.</p>
      </div>
    );
  }

  // A password-locked song not yet unlocked this session has no real content to show
  // (see CloudSongsRepository's placeholder) — gate on its password before rendering
  // the normal editor at all, rather than merely treating it as read-only.
  if (song.isUndecryptedPlaceholder) {
    return <SongPasswordGate song={song} />;
  }

  return (
    <div className={`${styles.editorWrapper} ${song.isReadOnly ? styles.lockedMode : ''}`}>
      <Toolbar
        song={song}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        showScratchpad={showScratchpad}
        onToggleScratchpad={handleToggleScratchpad}
      />
      <div className={`${styles.editorBody} ${showScratchpad ? styles.hasScratchpad : ''}`}>
        <div className={styles.editorScroll}>
          <div className={styles.linesContainer}>
            {song.lines.map((line) => {
              const isActive = focusState?.lineId === line.id;
              const isFocusTarget = pendingFocus?.lineId === line.id ? pendingFocus.track : null;
              const focusCaretIndex = pendingFocus?.lineId === line.id ? pendingFocus.caretIndex : null;
              return (
                <SongLine
                  key={line.id}
                  line={line}
                  locked={song.isReadOnly}
                  isActive={isActive}
                  focusTarget={isFocusTarget}
                  focusCaretIndex={focusCaretIndex}
                  onFocused={handleFocused}
                  onChange={handleChange}
                  onEnter={handleEnter}
                  onNavigate={handleNavigate}
                  onDelete={handleDelete}
                  onSplit={handleSplit}
                  onMergeWithPrevious={handleMergeWithPrevious}
                />
              );
            })}
          </div>
        </div>
        {showScratchpad && (
          <DAWPanel
            showPiano={showPiano}
            onTogglePiano={() => setShowPiano((p) => !p)}
            showDaw={showDaw}
            onToggleDaw={() => setShowDaw((d) => !d)}
          />
        )}
      </div>
      {song.isReadOnly && (
        <div className={styles.lockedBanner}>
          <span>🔒 Document is read-only — unlock from the toolbar to edit</span>
        </div>
      )}
    </div>
  );
}
