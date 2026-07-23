import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import BookLanding from './components/BookLanding/BookLanding';
import useSongsStore, { createSong } from './store/songsStore';
import useCloudSync from './auth/useCloudSync';
import useAuth from './auth/useAuth';
import { peekPendingSongIntent, clearPendingSongIntent, hasPendingSongIntent } from './auth/pendingSongIntent';
import { LocalSongsRepository } from './store/songsRepository';
import { isUnlocked } from './crypto/keyManager';
import styles from './App.module.css';
import authStyles from './auth/AuthPage.module.css';

/**
 * App layout: sidebar (Dashboard) + main (Editor).
 */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [bookOpened, setBookOpened] = useState(() => sessionStorage.getItem('songnotes_book_opened') === 'true');
  const status = useSongsStore((s) => s.status);
  const songs = useSongsStore((s) => s.songs);
  const { user, loading: authLoading, unlockAccountKey } = useAuth();
  const { isChecking } = useCloudSync();

  const repo = useSongsStore((s) => s.repo);
  const hydrate = useSongsStore((s) => s.hydrate);
  const setActiveSong = useSongsStore((s) => s.setActiveSong);

  // A pending intent can arrive signed in but without the account DEK established —
  // establishDEK() only ever runs inside signIn()/signUp()'s own explicit password
  // handling, never from Supabase's passive session restore. That's exactly what
  // happens when a signup confirmation link opens in a fresh tab/window: it silently
  // authenticates the user with no idea what their password was, so there's no way to
  // derive the DEK automatically. Ask for it here instead of losing the song.
  const [needsKeyPassword, setNeedsKeyPassword] = useState(false);
  const [keyPassword, setKeyPassword] = useState('');
  const [keyError, setKeyError] = useState(null);
  const [keySubmitting, setKeySubmitting] = useState(false);
  const [gateDismissed, setGateDismissed] = useState(false);
  const [fulfillTick, setFulfillTick] = useState(0); // bump to re-run the effect below

  useEffect(() => {
    function handleBeforeUnload(e) {
      if (!user && songs.length > 0) {
        e.preventDefault();
        e.returnValue = 'You are in guest mode. Sign up to save your progress permanently to the cloud and prevent data loss.';
        return e.returnValue;
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [user, songs]);

  // After a guest is redirected to sign in/up specifically to encrypt a song (either a
  // brand new one from the creation dialog, or an existing one from the Toolbar's
  // password-protect prompt), pick that intent back up once signed in and actually
  // fulfill it: create the song ENCRYPTED (not silently downgraded to plain) and drop
  // the user straight into it.
  useEffect(() => {
    // Wait for useCloudSync to finish swapping in the cloud repo. Reading the
    // store's `status`/`repo` right after sign-in (before that swap lands) can
    // observe stale leftovers from the prior guest session — status can still
    // read 'ready' with `repo` still pointing at the local/guest repository,
    // which would silently create the song in local storage instead of the
    // account. `isChecking` is fresh per-mount React state (not persisted like
    // the store), so it can't be stale the way `status` can.
    if (!user || isChecking || status !== 'ready') return;
    const intent = peekPendingSongIntent();
    if (!intent) {
      // Covers the intent having been fulfilled or expired elsewhere (e.g. another
      // tab that already had the DEK) while this tab was still showing the gate —
      // without this, needsKeyPassword would stay stuck true forever.
      setNeedsKeyPassword(false);
      return;
    }

    if (!isUnlocked()) {
      // Don't even attempt it — repo.create() would throw "set up an encryption
      // passphrase first" and, since the intent was already consumed, silently lose
      // the song. Leave it in storage and ask for the password instead.
      setNeedsKeyPassword(true);
      return;
    }
    setNeedsKeyPassword(false);

    async function fulfillIntent() {
      if (intent.mode === 'new') {
        // Deliberately NOT using the addSong() store action here: it optimistically
        // updates local state and fires-and-forgets the actual repo.create() network
        // call, so an immediate hydrate() right after would race ahead of it and
        // overwrite that optimistic state with a repo.list() that doesn't have the
        // new song yet, silently erasing it. Await the real creation first instead.
        const newSong = createSong(intent.title, { encrypted: true });
        await repo.create(newSong, { encrypted: true });
        clearPendingSongIntent(); // only now that creation actually succeeded
        await hydrate();
        setActiveSong(newSong.id);
        return;
      }

      // mode === 'existing': preserve the original id/content, just move it into the
      // account encrypted. Strip guest-only bookkeeping fields first.
      const { guestSessionId: _guestSessionId, encrypted: _encrypted, isLocked: _isLocked, isUndecryptedPlaceholder: _isUndecryptedPlaceholder, content: _content, ...cleanSong } = intent.song;
      const songToSave = { ...cleanSong, encrypted: true, updatedAt: new Date().toISOString() };
      await repo.create(songToSave, { encrypted: true });
      clearPendingSongIntent();
      // Remove the now-migrated guest-local copy so it doesn't linger as a stray
      // duplicate or get offered again later via the "import local songs" prompt.
      try {
        await new LocalSongsRepository().remove(intent.song.id);
      } catch (e) {
        console.error('SongNotes: failed to clean up migrated guest song', e);
      }
      await hydrate();
      setActiveSong(intent.song.id);
    }

    fulfillIntent().catch((err) => {
      console.error('SongNotes: failed to fulfill pending encrypt intent after sign-in', err);
    });
  }, [user, isChecking, status, repo, hydrate, setActiveSong, fulfillTick]);

  async function handleUnlockForIntent(e) {
    e.preventDefault();
    setKeyError(null);
    setKeySubmitting(true);
    try {
      await unlockAccountKey(keyPassword);
      setKeyPassword('');
      setFulfillTick((t) => t + 1); // re-run the effect above now that the DEK exists
    } catch (err) {
      setKeyError(err.message || 'Failed to unlock encryption.');
    } finally {
      setKeySubmitting(false);
    }
  }

  if (authLoading) {
    return <div className={styles.loadingScreen}>Loading SongNotes…</div>;
  }
  // If there's a pending song migration after sign-in, skip the book cover so the
  // user lands directly in the app.
  const shouldShowCover = !bookOpened && !user && !hasPendingSongIntent();
  if (shouldShowCover) {
    return (
      <BookLanding
        onOpen={() => {
          setBookOpened(true);
          sessionStorage.setItem('songnotes_book_opened', 'true');
        }}
      />
    );
  }

  if (isChecking) {
    return <div className={styles.loadingScreen}>Loading your songs…</div>;
  }

  if (status === 'error') {
    return <div className={styles.loadingScreen}>Couldn't load your songs. Try reloading the page.</div>;
  }
  if (status !== 'ready') {
    return <div className={styles.loadingScreen}>Loading your songs…</div>;
  }

  if (needsKeyPassword && !gateDismissed) {
    return (
      <div className={authStyles.page}>
        <div className={authStyles.card}>
          <div className={authStyles.logo}>
            <span className={authStyles.logoIcon}>♪</span>
            <span className={authStyles.logoText}>SongNotes</span>
          </div>
          <h1 className={authStyles.title}>Almost there</h1>
          <p className={authStyles.subtitle}>
            You're signed in, but this browser tab hasn't unlocked your account's
            encryption key yet. Enter your password to finish creating your song.
          </p>
          <form className={authStyles.form} onSubmit={handleUnlockForIntent}>
            <input
              className={authStyles.input}
              type="password"
              value={keyPassword}
              onChange={(e) => setKeyPassword(e.target.value)}
              placeholder="Account password"
              autoFocus
              required
              autoComplete="current-password"
            />
            {keyError && <div className={authStyles.errorText}>{keyError}</div>}
            <button className={authStyles.submitBtn} type="submit" disabled={keySubmitting} id="intent-unlock-key-btn">
              {keySubmitting ? 'Unlocking…' : 'Continue'}
            </button>
          </form>
          <button
            className={authStyles.guestLink}
            style={{ background: 'none', border: 'none', width: '100%', cursor: 'pointer' }}
            onClick={() => setGateDismissed(true)}
            id="intent-unlock-key-skip-btn"
          >
            Continue without finishing this →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.appLayout}>
      {sidebarOpen && <Dashboard />}

      {/* Centered vertical toggle handle on the seam */}
      <button
        className={`${styles.sidebarToggleHandle} ${sidebarOpen ? '' : styles.closed}`}
        onClick={() => setSidebarOpen(!sidebarOpen)}
        title={sidebarOpen ? "Hide Songs Sidebar" : "Show Songs Sidebar"}
        aria-label={sidebarOpen ? "Hide Songs Sidebar" : "Show Songs Sidebar"}
      >
        {sidebarOpen ? '‹' : '›'}
      </button>

      <main className={styles.main}>
        <Editor />
      </main>
    </div>
  );
}
