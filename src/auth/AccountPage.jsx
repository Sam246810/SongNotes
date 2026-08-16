import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import useAuth from './useAuth';
import { regenerateRecoveryCode, changePassword } from './accountRecovery';
import { getDEK, isUnlocked as dekIsUnlocked, establishDEK } from '../crypto/keyManager';
import { unlockWithPassphrase } from '../crypto/accountKeys';
import { SupabaseUserKeysAdapter } from '../lib/userKeysAdapter';
import { supabase } from '../lib/supabaseClient';
import styles from './AuthPage.module.css';

/**
 * Account settings — the one settings surface in the app. Two actions, both
 * thin wrappers over accountRecovery.js primitives:
 *
 *  - Regenerate recovery code: for anyone who never saved theirs (a real gap —
 *    several code paths used to mint one and silently discard it) or just wants
 *    to rotate it.
 *  - Change password: same rewrap-after-updateUser shape as the forgot-password
 *    recovery flow, so a signed-in password change can't desync the envelope
 *    from the auth password the way it used to.
 *
 * Both need the DEK already unlocked in this session; if it isn't, a small
 * password gate (same idea as Editor.jsx's AccountKeyGate) unlocks it first.
 */
export default function AccountPage() {
  const { user, loading } = useAuth();
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlocked, setUnlocked] = useState(dekIsUnlocked());

  const [newCode, setNewCode] = useState(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState(null);
  const [passwordChanged, setPasswordChanged] = useState(false);

  if (loading) return <div className={styles.page}><p className={styles.infoText}>Loading…</p></div>;
  if (!user) return <Navigate to="/login" replace />;

  async function handleUnlock(e) {
    e.preventDefault();
    setUnlockError(null);
    setUnlocking(true);
    try {
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, user.id);
      const current = await keysAdapter.get();
      if (!current) throw new Error('No account encryption key found for this account yet.');
      const dek = await unlockWithPassphrase(current.envelope, unlockPassword);
      await establishDEK(dek, user.id, current.envelope.dekId);
      setUnlocked(true);
    } catch (err) {
      setUnlockError(err.message || 'Incorrect password.');
    } finally {
      setUnlocking(false);
    }
  }

  async function handleRegenerateCode() {
    setRegenerateError(null);
    setRegenerating(true);
    try {
      const { recoveryCode } = await regenerateRecoveryCode({ userId: user.id, dek: getDEK() });
      setNewCode(recoveryCode);
    } catch (err) {
      setRegenerateError(err.message || 'Failed to regenerate your recovery code.');
    } finally {
      setRegenerating(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }
    setChangingPassword(true);
    try {
      await changePassword({ userId: user.id, dek: getDEK(), newPassword });
      setPasswordChanged(true);
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(err.message || 'Failed to change your password.');
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>♪</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <h1 className={styles.title}>Account</h1>
        <p className={styles.subtitle}>{user.email}</p>

        {!unlocked ? (
          <>
            <p className={styles.infoText}>Enter your account password to manage encryption settings.</p>
            <form className={styles.form} onSubmit={handleUnlock}>
              <input
                className={styles.input}
                type="password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                placeholder="Account password"
                autoFocus
                required
                autoComplete="current-password"
              />
              {unlockError && <div className={styles.errorText}>{unlockError}</div>}
              <button className={styles.submitBtn} type="submit" disabled={unlocking} id="account-unlock-btn">
                {unlocking ? 'Unlocking…' : 'Unlock'}
              </button>
            </form>
          </>
        ) : (
          <>
            <div className={styles.form}>
              <p className={styles.infoText}>
                Your recovery code is the only way to get your songs back if you ever forget
                your password. Regenerating replaces it — the old code stops working, your
                password and songs are untouched.
              </p>
              {newCode ? (
                <div className={styles.recoveryCode}>{newCode}</div>
              ) : (
                <>
                  {regenerateError && <div className={styles.errorText}>{regenerateError}</div>}
                  <button className={styles.submitBtn} type="button" onClick={handleRegenerateCode} disabled={regenerating} id="regenerate-recovery-code-btn">
                    {regenerating ? 'Regenerating…' : 'Regenerate recovery code'}
                  </button>
                </>
              )}
            </div>

            <div className={`${styles.form} ${styles.section}`}>
              <p className={styles.infoText}>Change your account password.</p>
              {passwordChanged ? (
                <p className={styles.infoText}>Password changed.</p>
              ) : (
                <form className={styles.form} onSubmit={handleChangePassword}>
                  <label className={styles.label}>
                    New Password
                    <input
                      className={styles.input}
                      type="password"
                      autoComplete="new-password"
                      minLength={6}
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
                      minLength={6}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                  </label>
                  {passwordError && <div className={styles.errorText}>{passwordError}</div>}
                  <button className={styles.submitBtn} type="submit" disabled={changingPassword} id="change-password-btn">
                    {changingPassword ? 'Changing…' : 'Change password'}
                  </button>
                </form>
              )}
            </div>
          </>
        )}

        <Link className={`${styles.guestLink} ${styles.section}`} to="/delete-account">
          Delete account…
        </Link>
        <Link className={styles.guestLink} to="/">← Back to SongNotes</Link>
      </div>
    </div>
  );
}
