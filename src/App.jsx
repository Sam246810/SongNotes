import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import BookLanding from './components/BookLanding/BookLanding';
import useSongsStore, { createSong } from './store/songsStore';
import useCloudSync from './auth/useCloudSync';
import useAuth from './auth/useAuth';
import { takePendingSongIntent, hasPendingSongIntent } from './auth/pendingSongIntent';
import { LocalSongsRepository } from './store/songsRepository';
import styles from './App.module.css';

/**
 * App layout: sidebar (Dashboard) + main (Editor).
 */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [bookOpened, setBookOpened] = useState(() => sessionStorage.getItem('songnotes_book_opened') === 'true');
  const status = useSongsStore((s) => s.status);
  const songs = useSongsStore((s) => s.songs);
  const { user, loading: authLoading } = useAuth();
  const { isChecking } = useCloudSync();

  const repo = useSongsStore((s) => s.repo);
  const hydrate = useSongsStore((s) => s.hydrate);
  const setActiveSong = useSongsStore((s) => s.setActiveSong);

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
    const intent = takePendingSongIntent();
    if (!intent) return;

    async function fulfillIntent() {
      if (intent.mode === 'new') {
        // Deliberately NOT using the addSong() store action here: it optimistically
        // updates local state and fires-and-forgets the actual repo.create() network
        // call, so an immediate hydrate() right after would race ahead of it and
        // overwrite that optimistic state with a repo.list() that doesn't have the
        // new song yet, silently erasing it. Await the real creation first instead.
        const newSong = createSong(intent.title, { encrypted: true });
        await repo.create(newSong, { encrypted: true });
        await hydrate();
        setActiveSong(newSong.id);
        return;
      }

      // mode === 'existing': preserve the original id/content, just move it into the
      // account encrypted. Strip guest-only bookkeeping fields first.
      const { guestSessionId: _guestSessionId, encrypted: _encrypted, isLocked: _isLocked, isUndecryptedPlaceholder: _isUndecryptedPlaceholder, content: _content, ...cleanSong } = intent.song;
      const songToSave = { ...cleanSong, encrypted: true, updatedAt: new Date().toISOString() };
      await repo.create(songToSave, { encrypted: true });
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
  }, [user, isChecking, status, repo, hydrate, setActiveSong]);

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
