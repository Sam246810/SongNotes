import { useState, useEffect } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import BookLanding from './components/BookLanding/BookLanding';
import PrivacyScreen from './components/PrivacyScreen/PrivacyScreen';
import useSongsStore from './store/songsStore';
import useCloudSync from './auth/useCloudSync';
import useAuth from './auth/useAuth';
import useDawSession, { selectAnyDawDirty } from './audio/dawSession';
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
  // Recorded/imported Scratchpad audio never persists across a reload on its own (see
  // src/audio/dawSession.js) — warn before leaving regardless of guest/signed-in status.
  const anyDawDirty = useDawSession(selectAnyDawDirty);

  // Manual "someone might glance at my screen" cover for the whole app — a
  // visibility toggle, not a new crypto scheme (content is already decrypted in
  // memory). Persisted so a reload while locked stays locked. Signed-in only: guests
  // have no account password to unlock it with.
  const [privacyLocked, setPrivacyLocked] = useState(
    () => sessionStorage.getItem('songnotes_privacy_locked') === 'true'
  );

  useEffect(() => {
    sessionStorage.setItem('songnotes_privacy_locked', privacyLocked ? 'true' : 'false');
  }, [privacyLocked]);

  useEffect(() => {
    function handleBeforeUnload(e) {
      if ((!user && songs.length > 0) || anyDawDirty) {
        e.preventDefault();
        e.returnValue = anyDawDirty
          ? 'You have recorded or imported Scratchpad audio that hasn\'t been exported — it will be lost if you leave.'
          : 'You are in guest mode. Sign up to save your progress permanently to the cloud and prevent data loss.';
        return e.returnValue;
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [user, songs, anyDawDirty]);

  if (authLoading) {
    return <div className={styles.loadingScreen}>Loading SongNotes…</div>;
  }

  if (user && privacyLocked) {
    return <PrivacyScreen onUnlock={() => setPrivacyLocked(false)} />;
  }

  const shouldShowCover = !bookOpened && !user;
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
      {sidebarOpen && <Dashboard onPrivacyLock={() => setPrivacyLocked(true)} />}

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
