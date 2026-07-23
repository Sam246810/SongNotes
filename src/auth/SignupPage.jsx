import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import useAuth from './useAuth';
import styles from './AuthPage.module.css';

export default function SignupPage() {
  const { configured, user, signUp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await signUp(email, password);
      if (!data.session) {
        // Email confirmation required before a session exists.
        setConfirmSent(true);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.message || 'Failed to sign up.');
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
        <h1 className={styles.title}>Create an account</h1>
        <p className={styles.subtitle}>
          This just syncs your songs to the cloud. Later, you can choose to
          <strong> encrypt</strong> individual songs so even we can't read them — that uses a
          separate passphrase, set up only when you turn it on.
        </p>

        {!configured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment yet. You can keep using SongNotes
            locally — see <Link to="/">back to the app</Link>.
          </p>
        )}

        {configured && confirmSent && (
          <p className={styles.infoText}>
            Check your email to confirm your account, then sign in.
          </p>
        )}

        {configured && !confirmSent && (
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
                autoComplete="new-password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && <div className={styles.errorText}>{error}</div>}
            <button className={styles.submitBtn} type="submit" disabled={submitting} id="signup-submit-btn">
              {submitting ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        )}

        <div className={styles.footer}>
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
        <Link className={styles.guestLink} to="/">Continue without an account →</Link>
      </div>
    </div>
  );
}
