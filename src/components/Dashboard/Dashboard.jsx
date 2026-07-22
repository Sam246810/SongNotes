import { useState } from 'react';
import useSongsStore from '../../store/songsStore';
import styles from './Dashboard.module.css';

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Dashboard() {
  const { songs, activeSongId, addSong, deleteSong, setActiveSong } = useSongsStore();
  const [confirmDelete, setConfirmDelete] = useState(null); // songId pending deletion

  function handleNew() {
    addSong('Untitled Song');
  }

  function handleOpen(id) {
    setActiveSong(id);
  }

  function handleDelete(e, id) {
    e.stopPropagation();
    setConfirmDelete(id);
  }

  function confirmDeleteSong() {
    if (confirmDelete) {
      deleteSong(confirmDelete);
      setConfirmDelete(null);
    }
  }

  return (
    <div className={styles.dashboard}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>♪</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <button className={styles.newBtn} onClick={handleNew} id="new-song-btn">
          + New Song
        </button>
      </div>

      {/* Song list */}
      <div className={styles.listArea}>
        {songs.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIllustration}>🎸</div>
            <p className={styles.emptyTitle}>No songs yet</p>
            <p className={styles.emptySubtitle}>Create your first song to get started</p>
            <button className={styles.emptyNewBtn} onClick={handleNew} id="empty-new-song-btn">
              + Create Song
            </button>
          </div>
        ) : (
          <ul className={styles.list}>
            {songs.map((song) => (
              <li
                key={song.id}
                className={`${styles.item} ${song.id === activeSongId ? styles.active : ''}`}
                onClick={() => handleOpen(song.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleOpen(song.id)}
                aria-label={`Open song: ${song.title}`}
                id={`song-item-${song.id}`}
              >
                <div className={styles.itemLeft}>
                  <span className={styles.itemIcon}>{song.locked ? '🔒' : '♪'}</span>
                  <div className={styles.itemMeta}>
                    <span className={styles.itemTitle}>{song.title}</span>
                    <span className={styles.itemDate}>
                      {song.lines.length} {song.lines.length === 1 ? 'line' : 'lines'} · {formatDate(song.updatedAt)}
                    </span>
                  </div>
                </div>
                <button
                  className={styles.deleteBtn}
                  onClick={(e) => handleDelete(e, song.id)}
                  title="Delete song"
                  aria-label={`Delete ${song.title}`}
                  id={`delete-song-${song.id}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Delete confirm modal */}
      {confirmDelete && (
        <div className={styles.overlay} onClick={() => setConfirmDelete(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.modalTitle}>Delete song?</h2>
            <p className={styles.modalText}>
              "{songs.find((s) => s.id === confirmDelete)?.title}" will be permanently deleted.
            </p>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setConfirmDelete(null)} id="delete-cancel-btn">Cancel</button>
              <button className={styles.confirmBtn} onClick={confirmDeleteSong} id="delete-confirm-btn">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
