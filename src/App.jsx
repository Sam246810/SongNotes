import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import BookLanding from './components/BookLanding/BookLanding';
import useSongsStore from './store/songsStore';
import useCloudSync from './auth/useCloudSync';
import useAuth from './auth/useAuth';
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

  useEffect(() => {
    if (!user || status !== 'ready') return;

    const pendingJson = sessionStorage.getItem('__songnotes_pending_song_data');
    if (!pendingJson) return;

    // Clear the flag immediately to prevent re-runs.
    sessionStorage.removeItem('__songnotes_pending_song_data');

    try {
      const pendingSong = JSON.parse(pendingJson);
      // Strip any guest-specific fields and create as a plain unencrypted cloud song.
      const { guestSessionId, encrypted, isLocked, isUndecryptedPlaceholder, content, ...cleanSong } = pendingSong;
      const songToSave = { ...cleanSong, encrypted: false, updatedAt: new Date().toISOString() };

      repo.create(songToSave, { encrypted: false }).then(() => {
        hydrate().then(() => {
          setActiveSong(pendingSong.id);
        });
      }).catch((err) => {
        console.error('Failed to migrate guest song after login:', err);
      });
    } catch (e) {
      console.error('Failed to parse pending song data:', e);
    }
  }, [user, status, repo, hydrate, setActiveSong]);

  if (authLoading) {
    return <div className={styles.loadingScreen}>Loading SongNotes…</div>;
  }
  // If there's a pending song migration after sign-in, skip the book cover so the
  // user lands directly in the app.
  const hasPendingSong = Boolean(sessionStorage.getItem('__songnotes_pending_song_data'));
  const shouldShowCover = !bookOpened && !user && !hasPendingSong;
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
        <Editor sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
      </main>
    </div>
  );
}
