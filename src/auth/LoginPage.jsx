import { useState, useRef } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import useAuth from './useAuth';
import { recoverWithRecoveryCode, rotateAndPurge } from './accountRecovery';
import styles from './AuthPage.module.css';

const RESET_CONFIRM_PHRASE = 'DELETE MY SONGS';

export default function LoginPage() {
  const { configured, user, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [keyMismatch, setKeyMismatch] = useState(false);
  // The user id from THIS sign-in's own response, not useAuth().user — the auth
  // context's session can lag a render or two behind onAuthStateChange (see the
  // submittingRef comment below), and every recovery step needs a userId.
  const [pendingUserId, setPendingUserId] = useState(null);
  // 'recover' (non-destructive, needs the recovery code) is the default/recommended
  // path — 'confirmReset'/'showNewCode' (mints a brand new key, purging every
  // existing encrypted song) is an explicit last resort for when the code isn't
  // available, gated behind a typed confirmation, not a single click.
  const [recoveryMode, setRecoveryMode] = useState('recover');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetting, setResetting] = useState(false);
  const [newRecoveryCode, setNewRecoveryCode] = useState(null);
  // Only reveal "don't have your recovery code?" after an actual failed attempt —
  // it used to sit one click away from the recovery form at all times, in exactly
  // the state where someone who mistyped their code once might click it instead
  // of trying again.
  const [hasFailedRecovery, setHasFailedRecovery] = useState(false);
  // Set when THIS sign-in was the very first one for an account with no
  // envelope yet — signIn() just minted a recovery code that's never been shown
  // before (see AuthProvider.jsx's `!current` branch). Block navigation until
  // it's acknowledged, same reasoning as SignupPage's own recovery-code step.
  const [freshRecoveryCode, setFreshRecoveryCode] = useState(null);
  const newCodeResolverRef = useRef(null);
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
        // password (most likely changed since encryption was set up, e.g. via a
        // forgot-password reset). Stay on this page so we can offer to fix it
        // while the password is still at hand — don't navigate away yet,
        // otherwise this becomes an unrecoverable dead end.
        setPendingUserId(result.user?.id ?? null);
        setKeyMismatch(true);
      } else if (result.recoveryCode) {
        // First sign-in for an account with no envelope yet — a recovery code
        // was just minted and has never been shown. Don't navigate away until
        // it's been seen and acknowledged.
        setFreshRecoveryCode(result.recoveryCode);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.message || 'Failed to sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRecoverWithCode(e) {
    e.preventDefault();
    setError(null);
    setRecovering(true);
    try {
      // Normalization (case/hyphen/whitespace-insensitive matching) happens inside
      // recoverWithRecoveryCode's crypto layer now, not here -- see recoveryCode.js.
      // newPassword is deliberately the SAME password just typed into the sign-in
      // form above — this rebinds the envelope to the password that's already
      // correct for auth, it doesn't change it.
      await recoverWithRecoveryCode({ userId: pendingUserId, code: recoveryCode, newPassword: password });
      navigate('/');
    } catch (err) {
      setHasFailedRecovery(true);
      setError(err.message || 'Failed to recover with that code.');
    } finally {
      setRecovering(false);
    }
  }

  async function handleRotateAndPurge(e) {
    e.preventDefault();
    setError(null);
    setResetting(true);
    try {
      await rotateAndPurge({
        userId: pendingUserId,
        newPassword: password,
        // Blocks until handleConfirmNewCode runs — see accountRecovery.js's
        // contract: nothing is written server-side until the new code has
        // actually been shown and acknowledged.
        onRecoveryCode: (code) =>
          new Promise((resolve) => {
            setNewRecoveryCode(code);
            newCodeResolverRef.current = resolve;
          }),
      });
      navigate('/');
    } catch (err) {
      setError(err.message || 'Failed to reset your account.');
      setNewRecoveryCode(null);
    } finally {
      setResetting(false);
    }
  }

  function handleConfirmNewCode() {
    newCodeResolverRef.current?.();
    newCodeResolverRef.current = null;
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
          Sync your songs across devices. Every song is automatically encrypted with this
          same account password.
        </p>

        {!configured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment yet. You can keep using SongNotes
            locally — see <Link to="/">back to the app</Link>.
          </p>
        )}

        {configured && freshRecoveryCode && (
          <div className={styles.form}>
            <p className={styles.infoText}>
              This account didn't have a recovery code saved yet, so a new one was just
              created. Save it somewhere safe — it's the only way to get your encrypted
              songs back if you ever forget your password. It won't be shown again.
            </p>
            <div className={styles.recoveryCode}>{freshRecoveryCode}</div>
            <button
              className={styles.submitBtn}
              type="button"
              onClick={() => { setFreshRecoveryCode(null); navigate('/'); }}
              id="confirm-fresh-recovery-code-btn"
            >
              I've saved it — continue
            </button>
          </div>
        )}

        {configured && !freshRecoveryCode && keyMismatch && newRecoveryCode && (
          <div className={styles.form}>
            <p className={styles.infoText}>
              Save this recovery code somewhere safe — it's the only way to get back into
              this (now empty) account if you forget your password again. It won't be shown
              again.
            </p>
            <div className={styles.recoveryCode}>{newRecoveryCode}</div>
            <button className={styles.submitBtn} type="button" onClick={handleConfirmNewCode} id="confirm-new-recovery-code-btn">
              I've saved it — continue
            </button>
          </div>
        )}

        {configured && keyMismatch && !newRecoveryCode && (
          <div className={styles.form}>
            <p className={styles.errorText}>
              You're signed in, but your saved encryption key doesn't match this password —
              likely because the password was changed since encryption was set up.
            </p>

            {recoveryMode === 'recover' ? (
              <>
                <p className={styles.infoText}>
                  Enter your recovery code (shown once when you signed up) to get back every
                  encrypted song under the original key — nothing is lost.
                </p>
                <form className={styles.form} onSubmit={handleRecoverWithCode}>
                  <input
                    className={styles.input}
                    type="text"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    placeholder="Recovery Code (XXXXX-XXXXX...)"
                    autoFocus
                    required
                  />
                  {error && <div className={styles.errorText}>{error}</div>}
                  <button className={styles.submitBtn} type="submit" disabled={recovering} id="recover-with-code-btn">
                    {recovering ? 'Recovering…' : 'Recover access'}
                  </button>
                </form>
                {hasFailedRecovery && (
                  <button
                    type="button"
                    className={`${styles.guestLink} ${styles.linkButton}`}
                    onClick={() => { setRecoveryMode('confirmReset'); setError(null); setResetConfirmText(''); }}
                    id="give-up-recovery-code-btn"
                  >
                    Still not working? Start fresh instead
                  </button>
                )}
              </>
            ) : (
              <>
                <p className={styles.infoText}>
                  Starting fresh mints a brand new encryption key from this password AND
                  permanently deletes every song currently encrypted under the old one —
                  they can't be decrypted with the new key, so there's nothing to keep.
                  This can't be undone. Only do this if you don't have your recovery code.
                </p>
                <form className={styles.form} onSubmit={handleRotateAndPurge}>
                  <label className={styles.label}>
                    Type "{RESET_CONFIRM_PHRASE}" to confirm
                    <input
                      className={styles.input}
                      type="text"
                      value={resetConfirmText}
                      onChange={(e) => setResetConfirmText(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  {error && <div className={styles.errorText}>{error}</div>}
                  <button
                    className={styles.submitBtn}
                    type="submit"
                    disabled={resetting || resetConfirmText.trim().toUpperCase() !== RESET_CONFIRM_PHRASE}
                    id="reset-encryption-btn"
                  >
                    {resetting ? 'Starting fresh…' : 'Delete old songs & start fresh'}
                  </button>
                </form>
                <button
                  type="button"
                  className={`${styles.guestLink} ${styles.linkButton}`}
                  onClick={() => { setRecoveryMode('recover'); setError(null); }}
                >
                  ← Back to recovery code
                </button>
              </>
            )}
            <Link className={styles.guestLink} to="/">Continue without resetting →</Link>
          </div>
        )}

        {configured && !keyMismatch && !freshRecoveryCode && (
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

        {configured && !keyMismatch && !freshRecoveryCode && (
          <Link className={styles.guestLink} to="/forgot-password">Forgot your password?</Link>
        )}

        <div className={styles.footer}>
          Don't have an account? <Link to="/signup">Sign up</Link>
        </div>
        <Link className={styles.guestLink} to="/">Continue without an account →</Link>
      </div>
    </div>
  );
}
