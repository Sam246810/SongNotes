import { useState, useRef } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import useAuth from './useAuth';
import styles from './AuthPage.module.css';

export default function LoginPage() {
  const { configured, user, signIn, resetAccountEncryption } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Supabase's onAuthStateChange can flip `user` truthy mid-way through our own
  // handleSubmit (before we've had a chance to check keyUnlockFailed and possibly
  // show the mismatch screen) — this guards the auto-redirect below from firing on
  // that intermediate render and racing ahead of us.
  const submittingRef = useRef(false);

  if (user && !keyMismatch && !submittingRef.current) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    submittingRef.current = true;
    try {
      const result = await signIn(email, password);
      if (result.keyUnlockFailed) {
        // Auth succeeded but the stored encryption envelope doesn't match this
        // password (most likely changed since encryption was set up). Stay on this
        // page so we can offer to fix it while the password is still at hand — don't
        // navigate away yet, otherwise this becomes an unrecoverable dead end.
        setKeyMismatch(true);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.message || 'Failed to sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetEncryption() {
    setResetting(true);
    setError(null);
    try {
      await resetAccountEncryption(password);
      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to reset encryption.');
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>♪</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>
          Sync your songs across devices. Encrypting a song uses this same account password —
          locking a song with its own separate password is optional.
        </p>

        {!configured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment yet. You can keep using SongNotes
            locally — see <Link to="/">back to the app</Link>.
          </p>
        )}

        {configured && keyMismatch && (
          <div className={styles.form}>
            <p className={styles.errorText}>
              You're signed in, but your saved encryption key doesn't match this password —
              likely because the password was changed since encryption was set up.
            </p>
            <p className={styles.infoText}>
              Reset your encryption key using this password? Any song-specific passwords still
              work either way. Songs that were encrypted (but not password-locked) under the old
              key will no longer be readable — this can't be undone.
            </p>
            {error && <div className={styles.errorText}>{error}</div>}
            <button
              className={styles.submitBtn}
              onClick={handleResetEncryption}
              disabled={resetting}
              id="reset-encryption-btn"
            >
              {resetting ? 'Resetting…' : 'Reset encryption key & continue'}
            </button>
            <Link className={styles.guestLink} to="/">Continue without resetting →</Link>
          </div>
        )}

        {configured && !keyMismatch && (
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
              />
            </label>
            <label className={styles.label}>
              Password
              <input
                className={styles.input}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && <div className={styles.errorText}>{error}</div>}
            <button className={styles.submitBtn} type="submit" disabled={submitting} id="login-submit-btn">
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}

        <div className={styles.footer}>
          Don't have an account? <Link to="/signup">Sign up</Link>
        </div>
        <Link className={styles.guestLink} to="/">Continue without an account →</Link>
      </div>
    </div>
  );
}
