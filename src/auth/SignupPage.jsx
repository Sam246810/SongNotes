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
  // 'form' -> (recoveryCode, if account-key setup succeeded) -> confirmSent | app
  const [step, setStep] = useState('form');
  const [recoveryCode, setRecoveryCode] = useState(null);
  const [hasSession, setHasSession] = useState(false);
  const [copied, setCopied] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const data = await signUp(email, password);
      setHasSession(Boolean(data.session));
      if (data.recoveryCode) {
        // Account-key setup can fail silently (see AuthProvider.signUp's own
        // try/catch) — only show this step when there's actually a code to show.
        setRecoveryCode(data.recoveryCode);
        setStep('recoveryCode');
      } else if (!data.session) {
        setStep('confirmSent');
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.message || 'Failed to sign up.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleRecoveryCodeContinue() {
    if (hasSession) navigate('/');
    else setStep('confirmSent');
  }

  async function handleCopyCode() {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
    } catch {
      // Clipboard access can be denied — the code is still selectable/visible either way.
    }
  }

  function handleDownloadCode() {
    const content = `SongNotes recovery code\n\n${recoveryCode}\n\nKeep this somewhere safe — it's the only way to get your encrypted songs back if you ever forget your password. It won't be shown again.`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'songnotes-recovery-code.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
          This syncs your songs to the cloud. Every song is automatically <strong>encrypted</strong>{' '}
          — protected by this same password, no separate passphrase to remember.
        </p>

        {!configured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment yet. You can keep using SongNotes
            locally — see <Link to="/">back to the app</Link>.
          </p>
        )}

        {configured && step === 'recoveryCode' && (
          <>
            <p className={styles.infoText}>
              Save this recovery code somewhere safe — it's the only way to get your
              encrypted songs back if you ever forget your password. It won't be shown
              again.
            </p>
            <div className={styles.recoveryCode}>{recoveryCode}</div>
            <div className={styles.form}>
              <button
                className={styles.submitBtn}
                type="button"
                onClick={handleCopyCode}
                id="signup-copy-recovery-btn"
              >
                {copied ? 'Copied!' : 'Copy to clipboard'}
              </button>
              <button
                className={styles.submitBtn}
                type="button"
                onClick={handleDownloadCode}
                id="signup-download-recovery-btn"
              >
                Download as file
              </button>
              <button
                className={styles.submitBtn}
                type="button"
                onClick={handleRecoveryCodeContinue}
                id="signup-recovery-continue-btn"
              >
                I've saved it — continue
              </button>
            </div>
          </>
        )}

        {configured && step === 'confirmSent' && (
          <p className={styles.infoText}>
            Check your email to confirm your account, then sign in.
          </p>
        )}

        {configured && step === 'form' && (
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
