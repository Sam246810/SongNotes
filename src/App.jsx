import { useEffect, useState } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import Editor from './components/Editor/Editor';
import useSongsStore from './store/songsStore';
import styles from './App.module.css';

/**
 * App layout: sidebar (Dashboard) + main (Editor).
 * React Router is set up so protected routes can be wired in for auth later.
 */
export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const status = useSongsStore((s) => s.status);
  const hydrate = useSongsStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

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
