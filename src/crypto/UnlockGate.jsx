import { useState } from 'react';
import styles from './UnlockGate.module.css';
import { unlockWithPassphrase, unlockWithRecoveryCode, rewrapWithNewPassphrase } from './accountKeys';

/**
 * Shown after login only when the account has an existing key envelope (i.e. the user
 * has encrypted at least one song before, possibly on another device) and no DEK is
 * established in memory yet. Unencrypted-only accounts never see this — there's
 * nothing to unlock.
 *
 * @param {object} props
 * @param {object} props.envelope - the stored user_keys envelope
 * @param {(dek: CryptoKey) => void} props.onUnlock
 * @param {(newEnvelope: object) => Promise<void>} props.onEnvelopeUpdated - persist a
 *   re-wrapped envelope after a passphrase reset via recovery code
 */
export default function UnlockGate({ envelope, onUnlock, onEnvelopeUpdated }) {
  const [mode, setMode] = useState('passphrase'); // 'passphrase' | 'recovery'
  const [passphrase, setPassphrase] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePassphraseSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const dek = await unlockWithPassphrase(envelope, passphrase);
      onUnlock(dek);
    } catch {
      setError('Wrong passphrase. Try again, or use your recovery code.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRecoverySubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const dek = await unlockWithRecoveryCode(envelope, recoveryCode.trim());
      const newEnvelope = await rewrapWithNewPassphrase(envelope, dek, newPassphrase);
      await onEnvelopeUpdated(newEnvelope);
      setSuccess('Passphrase reset. Unlocking…');
      onUnlock(dek);
    } catch {
      setError('That recovery code is not correct.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{mode === 'passphrase' ? '🔒 Unlock your songs' : '🔑 Reset with recovery code'}</h1>

        {mode === 'passphrase' ? (
          <>
            <p className={styles.subtitle}>
              Enter your encryption passphrase to decrypt your private songs. This is
              separate from your login password.
            </p>
            <form className={styles.form} onSubmit={handlePassphraseSubmit}>
              <label className={styles.label}>
                Encryption passphrase
                <input
                  className={styles.input}
                  type="password"
                  autoFocus
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  required
                />
              </label>
              {error && <div className={styles.errorText}>{error}</div>}
              <button className={styles.submitBtn} type="submit" disabled={submitting} id="unlock-submit-btn">
                {submitting ? 'Unlocking…' : 'Unlock'}
              </button>
            </form>
            <button
              className={styles.switchModeBtn}
              onClick={() => { setMode('recovery'); setError(null); }}
              id="unlock-forgot-passphrase-btn"
            >
              Forgot your passphrase? Use your recovery code →
            </button>
          </>
        ) : (
          <>
            <p className={styles.subtitle}>
              Enter your recovery code and choose a new passphrase. Your existing
              encrypted songs will become readable with the new passphrase.
            </p>
            <form className={styles.form} onSubmit={handleRecoverySubmit}>
              <label className={styles.label}>
                Recovery code
                <input
                  className={styles.input}
                  type="text"
                  autoFocus
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  required
                />
              </label>
              <label className={styles.label}>
                New passphrase
                <input
                  className={styles.input}
                  type="password"
                  minLength={8}
                  value={newPassphrase}
                  onChange={(e) => setNewPassphrase(e.target.value)}
                  required
                />
              </label>
              {error && <div className={styles.errorText}>{error}</div>}
              {success && <div className={styles.successText}>{success}</div>}
              <button className={styles.submitBtn} type="submit" disabled={submitting} id="recovery-submit-btn">
                {submitting ? 'Resetting…' : 'Reset passphrase & unlock'}
              </button>
            </form>
            <button
              className={styles.switchModeBtn}
              onClick={() => { setMode('passphrase'); setError(null); }}
              id="unlock-back-to-passphrase-btn"
            >
              ← Back to passphrase entry
            </button>
          </>
        )}
      </div>
    </div>
  );
}
