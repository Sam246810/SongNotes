import { useState } from 'react';
import { Link } from 'react-router-dom';
import useSongsStore from '../../store/songsStore';
import useAuth from '../../auth/useAuth';
import useLocalMigration from '../../auth/useLocalMigration';
import useDawSession, { selectAnyDawDirty } from '../../audio/dawSession';
import NewSongDialog from './NewSongDialog';
import ConfirmDialog from '../ConfirmDialog/ConfirmDialog';
import styles from './Dashboard.module.css';

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function Dashboard({ onPrivacyLock }) {
  const { songs, activeSongId, addSong, deleteSong, setActiveSong, updateSongMeta } = useSongsStore();
  const { configured, user, signOut } = useAuth();
  const [confirmDelete, setConfirmDelete] = useState(null); // songId pending deletion
  const [showNewSongDialog, setShowNewSongDialog] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const migration = useLocalMigration();

  // Recorded/imported Scratchpad audio is session-only (see src/audio/dawSession.js) —
  // warn before an action that would make it unreachable, rather than losing it silently.
  const deleteTargetDawDirty = useDawSession((s) => Boolean(confirmDelete && s.dirtyBySong[confirmDelete]));
  const anyDawDirty = useDawSession(selectAnyDawDirty);

  function handleSignOutClick() {
    if (anyDawDirty) {
      setShowSignOutConfirm(true);
    } else {
      signOut();
    }
  }

  function handleNew() {
    if (!configured) {
      // No accounts available at all in this deployment — ask for a title directly.
      const name = window.prompt("Enter song name:", "Untitled Song");
      if (name === null) return;
      addSong(name.trim() || 'Untitled Song');
      return;
    }
    setShowNewSongDialog(true);
  }

  // Signed-in users always get every song encrypted with their account key — no
  // per-song choice. Guests never encrypt (no account, no key).
  function handleNewSongDone({ title, lines, meta }) {
    setShowNewSongDialog(false);
    const songId = addSong(title || 'Untitled Song', { encrypted: !!user, lines });
    if (meta && Object.keys(meta).length > 0) updateSongMeta(songId, meta);
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

      {/* Account status */}
      {configured && (
        <div className={styles.accountBar}>
          {user ? (
            <>
              <span className={styles.accountEmail} title={user.email}>{user.email}</span>
              <div className={styles.accountActions}>
                <button
                  className={styles.accountLinkBtn}
                  onClick={onPrivacyLock}
                  title="Hide your songs until you enter your password again"
                  id="privacy-toggle-btn"
                >
                  🙈 Hide Screen
                </button>
                <button className={styles.accountLinkBtn} onClick={handleSignOutClick} id="sign-out-btn">
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <span className={styles.accountEmail}>Guest (local only)</span>
              <Link className={styles.accountLinkBtn} to="/login" id="sign-in-link">
                Sign in
              </Link>
            </>
          )}
        </div>
      )}

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

      {/* New song title prompt */}
      {showNewSongDialog && (
        <NewSongDialog
          onDone={handleNewSongDone}
          onCancel={() => setShowNewSongDialog(false)}
        />
      )}

      {/* One-time offer to import pre-existing local songs into the account */}
      {migration.show && (
        <div className={styles.overlay} onClick={migration.importing ? undefined : migration.handleDismiss}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.modalTitle}>Import your local songs?</h2>
            <p className={styles.modalText}>
              You have {migration.count} song{migration.count === 1 ? '' : 's'} saved on just this
              device. Import {migration.count === 1 ? 'it' : 'them'} into your account so they sync
              everywhere and get encrypted, like every other song in your account?
            </p>
            {migration.error && <p className={styles.modalErrorText}>{migration.error}</p>}
            <div className={styles.modalActions}>
              <button
                className={styles.cancelBtn}
                onClick={migration.handleDismiss}
                disabled={migration.importing}
                id="migration-dismiss-btn"
              >
                Not now
              </button>
              <button
                className={styles.confirmBtnPositive}
                onClick={migration.handleImport}
                disabled={migration.importing}
                id="migration-import-btn"
              >
                {migration.importing ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <div className={styles.overlay} onClick={() => setConfirmDelete(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className={styles.modalTitle}>Delete song?</h2>
            <p className={styles.modalText}>
              "{songs.find((s) => s.id === confirmDelete)?.title}" will be permanently deleted.
              {deleteTargetDawDirty && (
                <> This song also has unexported Scratchpad audio — deleting it will lose that too.</>
              )}
            </p>
            <div className={styles.modalActions}>
              <button className={styles.cancelBtn} onClick={() => setConfirmDelete(null)} id="delete-cancel-btn">Cancel</button>
              <button className={styles.confirmBtn} onClick={confirmDeleteSong} id="delete-confirm-btn">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Sign-out gate when unexported Scratchpad audio exists somewhere in the account */}
      {showSignOutConfirm && (
        <ConfirmDialog
          title="Unsaved Scratchpad audio"
          message="You have recorded or imported audio that hasn't been exported. Signing out may make it unreachable — export it first, or sign out anyway and lose it."
          cancelLabel="Cancel"
          onCancel={() => setShowSignOutConfirm(false)}
          confirmLabel="Sign out anyway"
          onConfirm={() => { setShowSignOutConfirm(false); signOut(); }}
          danger
          cancelId="sign-out-confirm-cancel-btn"
          confirmId="sign-out-confirm-btn"
        />
      )}
    </div>
  );
}
