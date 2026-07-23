import { useState } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import useSongsStore from './store/songsStore';
import useCloudSync from './auth/useCloudSync';
import UnlockGate from './crypto/UnlockGate';
import styles from './App.module.css';

/**
 * App layout: sidebar (Dashboard) + main (Editor).
 *
 * useCloudSync binds the right SongsRepository (local for guests, cloud for signed-in
 * accounts) and, only when the account has previously encrypted a song, gates on the
 * passphrase UnlockGate before the store hydrates — so encrypted rows can decrypt on
 * the very first load rather than showing placeholders that then flip to content.
 */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const status = useSongsStore((s) => s.status);
  const { showUnlockGate, isChecking, envelope, handleUnlock, handleEnvelopeUpdated } = useCloudSync();

  if (isChecking) {
    return <div className={styles.loadingScreen}>Loading your songs…</div>;
  }

  if (showUnlockGate) {
    return (
      <UnlockGate
        envelope={envelope}
        onUnlock={handleUnlock}
        onEnvelopeUpdated={handleEnvelopeUpdated}
      />
    );
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
