import { useState, useRef } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import useAuth from './useAuth';
import { MIN_PASSWORD_LENGTH, PASSWORD_HELP_TEXT, validateNewPassword } from './passwordPolicy';
import styles from './AuthPage.module.css';

export default function SignupPage() {
  const { configured, user, signUp, signOut } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // 'form' -> (recoveryCode, if account-key setup succeeded) -> confirmSent | app
  //        -> keySetupFailed (account created, encryption not) -> sign in again
  const [step, setStep] = useState('form');
  const [keySetupFailed, setKeySetupFailed] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState(null);
  const [hasSession, setHasSession] = useState(false);
  const [copied, setCopied] = useState(false);
  // With email confirmation off, supabase.auth.signUp() fires onAuthStateChange
  // (flipping `user` truthy) BEFORE signUp() resolves — and key setup (Argon2id)
  // takes a while after that. Without this guard the auto-redirect below fired on
  // that intermediate render and unmounted the page, so the recovery code was
  // minted but never shown. Same pattern as LoginPage's submittingRef.
  const submittingRef = useRef(false);

  if (user && !submittingRef.current && step !== 'recoveryCode' && step !== 'keySetupFailed') return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const policyError = validateNewPassword(password);
    if (policyError) {
      setError(policyError);
      return;
    }
    setSubmitting(true);
    submittingRef.current = true;
    try {
      const data = await signUp(email, password);
      setHasSession(Boolean(data.session));
      setKeySetupFailed(Boolean(data.keySetupFailed));
      if (data.recoveryCode) {
        // Shown even when keySetupFailed: the envelope (and its recovery wrap)
        // is already stored, so this is the code's only chance to be seen.
        setRecoveryCode(data.recoveryCode);
        setStep('recoveryCode');
      } else if (data.keySetupFailed) {
        setStep('keySetupFailed');
      } else if (!data.session) {
        setStep('confirmSent');
      } else {
        navigate('/');
      }
    } catch (err) {
      submittingRef.current = false;
      setError(err.message || 'Failed to sign up.');
    } finally {
      setSubmitting(false);
    }
  }

  // Signing in again is what finishes key setup (see AuthProvider.signUp), so
  // send the user there rather than into an app with no encryption key.
  async function handleSignInAgain() {
    try {
      await signOut();
    } catch (e) {
      console.error('Failed to sign out after encryption setup failure', e);
    }
    navigate('/login');
  }

  function handleRecoveryCodeContinue() {
    if (keySetupFailed) return handleSignInAgain();
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
            {keySetupFailed && (
              <div className={styles.errorText}>
                Encryption couldn't finish setting up on this device (not a password
                problem). After saving this code, sign in again to finish.
              </div>
            )}
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

        {configured && step === 'keySetupFailed' && (
          <>
            <div className={styles.errorText}>
              Your account was created, but encryption couldn't be set up on this
              device. This isn't a password problem — sign in again to finish setup.
            </div>
            <div className={styles.form}>
              <button
                className={styles.submitBtn}
                type="button"
                onClick={handleSignInAgain}
                id="signup-key-setup-retry-btn"
              >
                Sign in again
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
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <p className={styles.infoText}>{PASSWORD_HELP_TEXT}</p>
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
