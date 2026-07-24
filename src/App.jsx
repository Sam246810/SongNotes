import { useState, useEffect, useRef } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import BookLanding from './components/BookLanding/BookLanding';
import PrivacyScreen from './components/PrivacyScreen/PrivacyScreen';
import ConfirmDialog from './components/ConfirmDialog/ConfirmDialog';
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

  // Best-effort follow-up for unexported DAW audio: browsers deliberately block any custom
  // UI from appearing alongside their own native beforeunload dialog (and ignore custom
  // returnValue text) — there's no way around that. But if the user cancels that dialog and
  // stays on the page, we can still reach them with a clearer explanation afterward.
  const [showLeaveWarning, setShowLeaveWarning] = useState(false);
  const leaveWarningTimerRef = useRef(null);

  useEffect(() => {
    function handleBeforeUnload(e) {
      if ((!user && songs.length > 0) || anyDawDirty) {
        e.preventDefault();
        e.returnValue = anyDawDirty
          ? 'You have recorded or imported Scratchpad audio that hasn\'t been exported — it will be lost if you leave.'
          : 'You are in guest mode. Sign up to save your progress permanently to the cloud and prevent data loss.';
        if (anyDawDirty) {
          if (leaveWarningTimerRef.current) clearTimeout(leaveWarningTimerRef.current);
          leaveWarningTimerRef.current = setTimeout(() => setShowLeaveWarning(true), 400);
        }
        return e.returnValue;
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (leaveWarningTimerRef.current) clearTimeout(leaveWarningTimerRef.current);
    };
  }, [user, songs, anyDawDirty]);

  const shouldShowCover = !bookOpened && !user;

  let content;
  if (authLoading) {
    content = <div className={styles.loadingScreen}>Loading SongNotes…</div>;
  } else if (user && privacyLocked) {
    content = <PrivacyScreen onUnlock={() => setPrivacyLocked(false)} />;
  } else if (shouldShowCover) {
    content = (
      <BookLanding
        onOpen={() => {
          setBookOpened(true);
          sessionStorage.setItem('songnotes_book_opened', 'true');
        }}
      />
    );
  } else if (isChecking) {
    content = <div className={styles.loadingScreen}>Loading your songs…</div>;
  } else if (status === 'error') {
    content = <div className={styles.loadingScreen}>Couldn't load your songs. Try reloading the page.</div>;
  } else if (status !== 'ready') {
    content = <div className={styles.loadingScreen}>Loading your songs…</div>;
  } else {
    content = (
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

  return (
    <>
      {content}
      {showLeaveWarning && (
        <ConfirmDialog
          title="Don't forget to export"
          message="You stayed on the page — remember to export your Scratchpad audio before closing this tab. It won't be saved automatically."
          confirmLabel="Got it"
          onConfirm={() => setShowLeaveWarning(false)}
          confirmId="daw-leave-warning-dismiss-btn"
        />
      )}
    </>
  );
}
