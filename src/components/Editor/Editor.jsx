import { useState, useCallback } from 'react';
import useSongsStore from '../../store/songsStore';
import useAuth from '../../auth/useAuth';
import SongLine from '../SongLine/SongLine';
import Toolbar from '../Toolbar/Toolbar';
import PianoPanel from '../PianoPanel/PianoPanel';
import DAWPanel from '../DAWPanel/DAWPanel';
import styles from './Editor.module.css';

/** Shown instead of the editor for a password-locked song not yet unlocked this session. */
function SongPasswordGate({ song }) {
  const unlockSong = useSongsStore((s) => s.unlockSong);
  const unlockSongWithRecoveryCode = useSongsStore((s) => s.unlockSongWithRecoveryCode);
  const [mode, setMode] = useState('password'); // 'password' | 'recovery'
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'password') {
        await unlockSong(song.id, password);
      } else {
        await unlockSongWithRecoveryCode(song.id, recoveryCode.trim());
      }
    } catch (err) {
      setError(err.message || 'Failed to unlock song.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>🔒</div>
      <p>{mode === 'password' ? 'This song is password-protected.' : 'Unlock with Recovery Code'}</p>
      <form className={styles.unlockForm} onSubmit={handleSubmit}>
        {mode === 'password' ? (
          <input
            type="password"
            className={styles.unlockInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Song password"
            autoFocus
            required
            autoComplete="new-password"
          />
        ) : (
          <input
            type="text"
            className={styles.unlockInput}
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="Recovery Code (XXXXX-XXXXX...)"
            autoFocus
            required
          />
        )}
        <button type="submit" className={styles.unlockBtn} disabled={submitting} id="song-password-unlock-btn">
          {submitting ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      {error && <p className={styles.unlockError}>{error}</p>}

      <button
        type="button"
        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer', marginTop: '12px', textDecoration: 'underline' }}
        onClick={() => {
          setMode(mode === 'password' ? 'recovery' : 'password');
          setError(null);
        }}
      >
        {mode === 'password' ? 'Forgot song password? Use recovery code' : '← Back to song password'}
      </button>
    </div>
  );
}

/**
 * Shown instead of the editor for a DEK-only encrypted song (never given its own
 * password) when the account encryption key just isn't unlocked in this session —
 * e.g. the browser was closed and reopened, so the Supabase auth session (persisted
 * in localStorage) survived but the DEK cached in sessionStorage didn't. This is
 * NOT a per-song lock, so it must not be confused with SongPasswordGate above:
 * there is no song password to enter here, only the account password.
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
      setError(err.message || 'Failed to unlock account encryption key.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyIcon}>🔐</div>
      <p>This song is encrypted with your account key, which isn't unlocked in this session.</p>
      <form className={styles.unlockForm} onSubmit={handleSubmit}>
        <input
          type="password"
          className={styles.unlockInput}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Account password"
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

  // An undecryptable song has no real content to show (see repository placeholders)
  // — gate before rendering the normal editor, rather than merely treating it as
  // read-only. Two distinct causes need two distinct gates: a song actually
  // password-locked (isLocked) needs its own password; a DEK-only encrypted song
  // that just isn't unlocked this session needs the ACCOUNT password instead — it
  // was never given a song password, so asking for one is both wrong and, per past
  // testing, produces a confusing "not password-locked" error on submit.
  if (song.isUndecryptedPlaceholder) {
    return song.isLocked ? <SongPasswordGate song={song} /> : <AccountKeyGate />;
  }

  return (
    <div className={styles.editorWrapper}>
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
                  locked={false}
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
    </div>
  );
}
