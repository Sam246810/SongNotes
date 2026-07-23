import { useState } from 'react';
import styles from './NewSongDialog.module.css';

/**
 * Shown every time a new song is created, letting the user enter a song title.
 * Encryption is no longer a per-song choice — signed-in users get every song
 * encrypted automatically, guests never do (see Dashboard.jsx's handleEncryptChoiceDone).
 *
 * @param {(result: {title: string}) => void} onDone
 * @param {() => void} onCancel
 */
export default function NewSongDialog({ onDone, onCancel }) {
  const [songTitle, setSongTitle] = useState('Untitled Song');

  function handleSubmit(e) {
    e.preventDefault();
    onDone({ title: songTitle.trim() || 'Untitled Song' });
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className={styles.title}>Create New Song</h2>

        <form onSubmit={handleSubmit}>
          <div className={styles.titleInputContainer}>
            <label className={styles.inputLabel} htmlFor="new-song-title">Song Title</label>
            <input
              id="new-song-title"
              type="text"
              className={styles.titleInput}
              value={songTitle}
              onChange={(e) => setSongTitle(e.target.value)}
              placeholder="e.g. Yesterday"
              autoFocus
            />
          </div>

          <button type="submit" className={styles.createBtn} id="new-song-create-btn">
            Create
          </button>
        </form>
        <button className={styles.cancelLink} onClick={onCancel} id="new-song-cancel-btn">
          Cancel
        </button>
      </div>
    </div>
  );
}
