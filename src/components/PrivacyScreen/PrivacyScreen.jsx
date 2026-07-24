import { useState } from 'react';
import useAuth from '../../auth/useAuth';
import styles from '../../auth/AuthPage.module.css';

/**
 * Whole-app privacy cover — a manual "someone might see my screen" toggle, not a new
 * crypto scheme. Content is already decrypted in memory; this just keeps it out of the
 * DOM entirely (App.jsx renders this INSTEAD of Dashboard/Editor, not on top of them)
 * until the account password is re-entered. Reuses the existing unlockAccountKey,
 * which already throws on a wrong password via WebCrypto's authenticated unwrap
 * failing — that doubles as password verification with no new crypto code.
 */
export default function PrivacyScreen({ onUnlock }) {
  const { unlockAccountKey } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await unlockAccountKey(password);
      onUnlock();
    } catch {
      setError('Incorrect password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>🙈</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <h1 className={styles.title}>Screen is hidden</h1>
        <p className={styles.subtitle}>
          Enter your account password to reveal your songs again.
        </p>
        <form className={styles.form} onSubmit={handleSubmit}>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Account password"
            autoFocus
            required
            autoComplete="current-password"
          />
          {error && <div className={styles.errorText}>{error}</div>}
          <button className={styles.submitBtn} type="submit" disabled={submitting} id="privacy-unlock-btn">
            {submitting ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}
