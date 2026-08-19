import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { hasAccountKeys, recoverWithRecoveryCode, rotateAndPurge } from './accountRecovery';
import { MIN_PASSWORD_LENGTH, PASSWORD_HELP_TEXT, validateNewPassword } from './passwordPolicy';
import styles from './AuthPage.module.css';

const RESET_CONFIRM_PHRASE = 'DELETE MY SONGS';

/**
 * Reached from a Supabase password-reset email link. The link carries a
 * one-time recovery session in the URL hash (auth-js consumes it at module
 * load — see supabaseClient.js) that's a REAL, persisted session, just like a
 * normal sign-in, not some limited-purpose token — so it's read directly via
 * `supabase.auth.getSession()`/`onAuthStateChange` here rather than through
 * AuthProvider's own `session` state, which can lag a render behind the
 * PASSWORD_RECOVERY event (auth-js dispatches it via a 0ms setTimeout during
 * URL-session processing).
 *
 * This page deliberately never has a DEK of its own to start with — see
 * accountRecovery.js for why the recovery code (or, if lost, a full rotate +
 * purge) is the only way to get one here.
 */
export default function ResetPasswordPage() {
  const navigate = useNavigate();
  // 'loading' | 'noSession' | 'form' | 'confirmPurge' | 'showNewCode' | 'done'
  const [status, setStatus] = useState(isSupabaseConfigured ? 'loading' : 'noSession');
  const [userId, setUserId] = useState(null);
  const [hasKeys, setHasKeys] = useState(true); // fail toward the safer (code-requiring) path
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const resolvedRef = useRef(false);
  const newCodeResolverRef = useRef(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let cancelled = false;

    async function proceedWithSession(session) {
      if (cancelled || !session?.user || resolvedRef.current) return;
      resolvedRef.current = true;
      setUserId(session.user.id);
      try {
        const has = await hasAccountKeys(session.user.id);
        if (!cancelled) setHasKeys(has);
      } catch {
        // Leave hasKeys at its fail-safe default (true) rather than letting a
        // transient network error skip straight to "no encryption to recover".
      }
      if (!cancelled) setStatus('form');
    }

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session?.user) {
        proceedWithSession(data.session);
      }
      // If there's no session yet, wait for PASSWORD_RECOVERY below rather than
      // declaring the link dead immediately — it can arrive a tick later.
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session?.user) proceedWithSession(session);
    });

    const timer = setTimeout(() => {
      if (!cancelled && !resolvedRef.current) setStatus('noSession');
    }, 4000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      sub.subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const policyError = validateNewPassword(newPassword);
    if (policyError) {
      setError(policyError);
      return;
    }
    setSubmitting(true);
    try {
      if (hasKeys) {
        await recoverWithRecoveryCode({ userId, code: recoveryCode, newPassword });
      } else {
        // No envelope exists for this account at all (e.g. it was never fully
        // set up) — nothing encrypted to recover, so just set the new password.
        const { error: pwError } = await supabase.auth.updateUser({ password: newPassword });
        if (pwError) throw pwError;
      }
      setStatus('done');
    } catch (err) {
      setError(err.message || "That recovery code didn't work.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRotateAndPurge(e) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const policyError = validateNewPassword(newPassword);
    if (policyError) {
      setError(policyError);
      return;
    }
    setSubmitting(true);
    try {
      await rotateAndPurge({
        userId,
        newPassword,
        onRecoveryCode: (code) =>
          new Promise((resolve) => {
            setNewRecoveryCode(code);
            setStatus('showNewCode');
            newCodeResolverRef.current = resolve;
          }),
      });
      setStatus('done');
    } catch (err) {
      setError(err.message || 'Failed to reset your account.');
      setStatus('confirmPurge');
    } finally {
      setSubmitting(false);
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
        <h1 className={styles.title}>Set a new password</h1>

        {!isSupabaseConfigured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment yet. You can keep using SongNotes
            locally — see <Link to="/">back to the app</Link>.
          </p>
        )}

        {isSupabaseConfigured && status === 'loading' && (
          <p className={styles.infoText}>Checking your reset link…</p>
        )}

        {isSupabaseConfigured && status === 'noSession' && (
          <>
            <p className={styles.errorText}>
              This reset link is invalid or has expired — links only work once, and go stale
              after a while.
            </p>
            <Link className={styles.guestLink} to="/forgot-password">Request a new link →</Link>
          </>
        )}

        {isSupabaseConfigured && status === 'done' && (
          <p className={styles.infoText}>
            Your password has been reset.{' '}
            <button type="button" className={styles.linkButton} onClick={() => navigate('/login')}>
              Sign in
            </button>{' '}
            with it now.
          </p>
        )}

        {isSupabaseConfigured && status === 'showNewCode' && newRecoveryCode && (
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

        {isSupabaseConfigured && status === 'form' && (
          <>
            <p className={styles.subtitle}>
              {hasKeys
                ? "You'll also need your recovery code — SongNotes never has a way to read your encrypted songs without it, even to reset your password."
                : 'Choose a new password to sign in with.'}
            </p>
            <form className={styles.form} onSubmit={handleSubmit}>
              {hasKeys && (
                <label className={styles.label}>
                  Recovery Code
                  <input
                    className={styles.input}
                    type="text"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                    autoFocus
                    required
                  />
                </label>
              )}
              <label className={styles.label}>
                New Password
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </label>
              <label className={styles.label}>
                Confirm New Password
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </label>
              {error && <div className={styles.errorText}>{error}</div>}
              <button className={styles.submitBtn} type="submit" disabled={submitting} id="reset-password-submit-btn">
                {submitting ? 'Resetting…' : 'Set new password'}
              </button>
            </form>
            {hasKeys && (
              <button
                type="button"
                className={`${styles.guestLink} ${styles.linkButton}`}
                onClick={() => { setStatus('confirmPurge'); setError(null); setResetConfirmText(''); }}
                id="lost-recovery-code-btn"
              >
                Lost your recovery code?
              </button>
            )}
          </>
        )}

        {isSupabaseConfigured && status === 'confirmPurge' && (
          <>
            <p className={styles.errorText}>
              Starting fresh mints a brand new encryption key AND permanently deletes every
              song currently encrypted under the old one — they can't be decrypted with the
              new key, so there's nothing to keep. This can't be undone.
            </p>
            <form className={styles.form} onSubmit={handleRotateAndPurge}>
              <label className={styles.label}>
                New Password
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </label>
              <label className={styles.label}>
                Confirm New Password
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </label>
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
                disabled={submitting || resetConfirmText.trim().toUpperCase() !== RESET_CONFIRM_PHRASE}
                id="rotate-and-purge-btn"
              >
                {submitting ? 'Starting fresh…' : 'Delete old songs & start fresh'}
              </button>
            </form>
            <button
              type="button"
              className={`${styles.guestLink} ${styles.linkButton}`}
              onClick={() => { setStatus('form'); setError(null); }}
            >
              ← Back to recovery code
            </button>
          </>
        )}
      </div>
    </div>
  );
}
