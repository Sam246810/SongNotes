import useSongsStore from '../../store/songsStore';
import styles from './SyncNotice.module.css';

/**
 * Says so when a sync conflict moved this device's edit out of a song: the
 * song now shows the version another device saved, and the edit lives on in
 * a "(conflict copy …)" song, which this offers to open.
 */
export default function SyncNotice() {
  const notice = useSongsStore((s) => s.syncNotice);
  const copyExists = useSongsStore((s) => Boolean(notice && s.songs.some((song) => song.id === notice.copyId)));
  const setActiveSong = useSongsStore((s) => s.setActiveSong);
  const dismiss = useSongsStore((s) => s.dismissSyncNotice);
  if (!notice) return null;

  return (
    <div className={styles.notice} role="status" id="sync-conflict-notice">
      <span className={styles.message}>
        This song was changed on another device at the same time. It now shows that version; your edit
        was saved as <strong>{notice.copyTitle}</strong>.
      </span>
      {copyExists && (
        <button
          type="button"
          className={styles.action}
          onClick={() => { setActiveSong(notice.copyId); dismiss(); }}
          id="sync-conflict-open-copy-btn"
        >
          Open my edit
        </button>
      )}
      <button
        type="button"
        className={styles.dismiss}
        onClick={dismiss}
        aria-label="Dismiss"
        id="sync-conflict-dismiss-btn"
      >
        ×
      </button>
    </div>
  );
}
