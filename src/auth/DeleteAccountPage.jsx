import { useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from './useAuth';
import { deleteAccount } from './accountRecovery';
import styles from './AuthPage.module.css';

const DELETE_CONFIRM_PHRASE = 'DELETE MY ACCOUNT';

/**
 * Public account-deletion page — the web resource the Android app links out
 * to, since Google Play requires an actual account+data deletion flow (not a
 * "contact support" placeholder). Exempt from main.jsx's mobile gate, since
 * it exists specifically to be opened from a phone.
 *
 * Sign-in is self-contained here rather than redirecting to /login, because
 * most visitors arrive cold from a link in the Android app, on a browser with
 * no existing web session to lose track of. Deleting only needs the Supabase
 * auth session, not the account encryption key, so unlike AccountPage there's
 * no DEK-unlock step — signIn()'s own DEK setup/unlock running (or failing)
 * as a side effect doesn't matter for what this page does.
 */
export default function DeleteAccountPage() {
  const { configured, user, loading, signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signInError, setSignInError] = useState(null);
  const [signingIn, setSigningIn] = useState(false);

  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [deleted, setDeleted] = useState(false);

  async function handleSignIn(e) {
    e.preventDefault();
    setSignInError(null);
    setSigningIn(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setSignInError(err.message || 'Failed to sign in.');
    } finally {
      setSigningIn(false);
    }
  }

  async function handleDelete(e) {
    e.preventDefault();
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAccount();
      setDeleted(true);
    } catch (err) {
      setDeleteError(err.message || 'Failed to delete your account.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>♪</span>
          <span className={styles.logoText}>SongNotes</span>
        </div>
        <h1 className={styles.title}>Delete your account</h1>

        {!configured && (
          <p className={styles.infoText}>
            Accounts aren't configured for this deployment, so there's no account to delete.
          </p>
        )}

        {configured && loading && <p className={styles.infoText}>Loading…</p>}

        {configured && !loading && deleted && (
          <p className={styles.infoText}>
            Your account and every song in it have been permanently deleted. You can close this
            page, or <Link to="/">continue using SongNotes as a guest</Link>.
          </p>
        )}

        {configured && !loading && !deleted && !user && (
          <>
            <p className={styles.subtitle}>
              Sign in below, then confirm on the next step. Deleting your account permanently
              removes it and every song in it, on every device — this can't be undone.
            </p>
            <form className={styles.form} onSubmit={handleSignIn}>
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
              {signInError && <div className={styles.errorText}>{signInError}</div>}
              <button
                className={styles.submitBtn}
                type="submit"
                disabled={signingIn}
                id="delete-account-signin-btn"
              >
                {signingIn ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        )}

        {configured && !loading && !deleted && user && (
          <div className={styles.form}>
            <p className={styles.subtitle}>Signed in as {user.email}</p>
            <p className={styles.errorText}>
              This permanently deletes your account and every song in it — on every device, with
              no recovery code or password able to bring it back. This can't be undone.
            </p>
            <form className={styles.form} onSubmit={handleDelete}>
              <label className={styles.label}>
                Type "{DELETE_CONFIRM_PHRASE}" to confirm
                <input
                  className={styles.input}
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {deleteError && <div className={styles.errorText}>{deleteError}</div>}
              <button
                className={styles.submitBtn}
                type="submit"
                disabled={deleting || confirmText.trim().toUpperCase() !== DELETE_CONFIRM_PHRASE}
                id="delete-account-confirm-btn"
              >
                {deleting ? 'Deleting…' : 'Permanently delete my account'}
              </button>
            </form>
          </div>
        )}

        {configured && !loading && !deleted && (
          <Link className={styles.guestLink} to="/">← Back to SongNotes</Link>
        )}
      </div>
    </div>
  );
}
