import { useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from './useAuth';
import styles from './AuthPage.module.css';

export default function ForgotPasswordPage() {
  const { configured, requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      // Always show the same confirmation regardless of whether the address is
      // actually registered — a different message for "unknown email" would let
      // anyone probe which addresses have accounts.
      setSent(true);
    } catch (err) {
      setError(err.message || 'Failed to send the reset email.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>♪</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <h1 className={styles.title}>Reset your password</h1>
        <p className={styles.subtitle}>
          We'll email you a link to set a new password. You'll still need your recovery
          code afterward to get your encrypted songs back — SongNotes never has a way to
          read them without it.
        </p>

        {!configured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment yet. You can keep using SongNotes
            locally — see <Link to="/">back to the app</Link>.
          </p>
        )}

        {configured && sent && (
          <p className={styles.infoText}>
            If an account exists for that email, a reset link is on its way. Open it on
            this device to finish resetting your password.
          </p>
        )}

        {configured && !sent && (
          <form className={styles.form} onSubmit={handleSubmit}>
            <label className={styles.label}>
              Email
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
            {error && <div className={styles.errorText}>{error}</div>}
            <button className={styles.submitBtn} type="submit" disabled={submitting} id="forgot-password-submit-btn">
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <div className={styles.footer}>
          Remembered it? <Link to="/login">Sign in</Link>
        </div>
        <Link className={styles.guestLink} to="/">Continue without an account →</Link>
      </div>
    </div>
  );
}
