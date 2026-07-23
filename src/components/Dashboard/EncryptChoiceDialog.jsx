import { useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from '../../auth/useAuth';
import styles from './EncryptChoiceDialog.module.css';

/**
 * Shown every time a new song is created, letting the user enter a song name and choose per song
 * whether it is end-to-end encrypted.
 *
 * @param {(result: {encrypted: boolean, title: string}) => void} onDone
 * @param {() => void} onCancel
 */
export default function EncryptChoiceDialog({ onDone, onCancel }) {
  const { user } = useAuth();
  const [step, setStep] = useState('choice'); // 'choice' | 'need-signin'
  const [songTitle, setSongTitle] = useState('Untitled Song');

  function choosePlain() {
    onDone({ encrypted: false, title: songTitle.trim() || 'Untitled Song' });
  }

  function chooseEncrypt() {
    if (!user) {
      setStep('need-signin');
      return;
    }
    onDone({ encrypted: true, title: songTitle.trim() || 'Untitled Song' });
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {step === 'choice' && (
          <>
            <h2 className={styles.title}>Create New Song</h2>

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

            <p className={styles.body}>
              <strong>Encrypted</strong> songs are private — even we can't read them.<br /><br />
              <strong>Unencrypted</strong> songs can't be lost if you lose credentials, but they are stored in plaintext.
            </p>
            <div className={styles.choiceActions}>
              <button className={styles.encryptBtn} onClick={chooseEncrypt} id="encrypt-choice-encrypt-btn">
                🔒 Encrypt · recommended
              </button>
              <button className={styles.plainBtn} onClick={choosePlain} id="encrypt-choice-plain-btn">
                Don't encrypt
              </button>
            </div>
            <button className={styles.cancelLink} onClick={onCancel} id="encrypt-choice-cancel-btn">
              Cancel
            </button>
          </>
        )}

        {step === 'need-signin' && (
          <>
            <h2 className={styles.title}>Sign in to encrypt songs</h2>
            <p className={styles.body}>
              Encryption is tied to your account. Sign in or create an account, then try again —
              or just create this song without encryption for now.
            </p>
            <div className={styles.choiceActions}>
              <Link className={styles.encryptBtn} to="/login" id="encrypt-choice-signin-link">
                Sign in
              </Link>
              <button className={styles.plainBtn} onClick={choosePlain} id="encrypt-choice-plain-instead-btn">
                Don't encrypt instead
              </button>
            </div>
            <button className={styles.cancelLink} onClick={onCancel} id="encrypt-choice-cancel-btn-2">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
