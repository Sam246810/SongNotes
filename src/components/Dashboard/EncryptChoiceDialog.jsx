import { useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from '../../auth/useAuth';
import { supabase } from '../../lib/supabaseClient';
import { SupabaseUserKeysAdapter } from '../../lib/userKeysAdapter';
import { createAccountKeys, generateRecoveryCode } from '../../crypto/accountKeys';
import { establishDEK, isUnlocked } from '../../crypto/keyManager';
import styles from './EncryptChoiceDialog.module.css';

/**
 * Shown every time a new song is created, letting the user choose per song whether
 * it's end-to-end encrypted. If they pick Encrypt and no account key exists yet, this
 * also runs the one-time lazy key setup (passphrase + recovery code) before finishing.
 *
 * @param {(result: {encrypted: boolean}) => void} onDone
 * @param {() => void} onCancel
 */
export default function EncryptChoiceDialog({ onDone, onCancel }) {
  const { user } = useAuth();
  const [step, setStep] = useState('choice'); // choice | need-signin | setup-passphrase | setup-recovery
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [error, setError] = useState(null);
  const [recoveryCode] = useState(() => generateRecoveryCode());
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function choosePlain() {
    onDone({ encrypted: false });
  }

  function chooseEncrypt() {
    if (!user) {
      setStep('need-signin');
      return;
    }
    if (isUnlocked()) {
      onDone({ encrypted: true });
      return;
    }
    setStep('setup-passphrase');
  }

  function handlePassphraseSubmit(e) {
    e.preventDefault();
    setError(null);
    if (passphrase.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError("Passphrases don't match.");
      return;
    }
    setStep('setup-recovery');
  }

  async function handleFinishSetup() {
    setSubmitting(true);
    setError(null);
    try {
      const { dek, envelope } = await createAccountKeys(passphrase, recoveryCode);
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, user.id);
      await keysAdapter.upsert(envelope);
      establishDEK(dek);
      onDone({ encrypted: true });
    } catch (err) {
      setError(err.message || 'Failed to set up encryption. Try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {step === 'choice' && (
          <>
            <h2 className={styles.title}>Encrypt this song?</h2>
            <p className={styles.body}>
              <strong>Encrypted</strong> songs are private — even we can't read them. If you
              lose your passphrase <strong>and</strong> recovery code, the song is gone for
              good.<br /><br />
              <strong>Unencrypted</strong> songs can't be lost that way — we still won't touch
              them, but they're slightly more exposed if our database is ever breached.
            </p>
            <div className={styles.choiceActions}>
              <button className={styles.encryptBtn} onClick={chooseEncrypt} id="encrypt-choice-encrypt-btn">
                🔒 Encrypt · recommended
              </button>
              <button className={styles.plainBtn} onClick={choosePlain} id="encrypt-choice-plain-btn">
                Don't encrypt
              </button>
            </div>
            <button className={styles.cancelLink} onClick={onCancel} id="encrypt-choice-cancel-btn">
              Cancel
            </button>
          </>
        )}

        {step === 'need-signin' && (
          <>
            <h2 className={styles.title}>Sign in to encrypt songs</h2>
            <p className={styles.body}>
              Encryption is tied to your account. Sign in or create an account, then try again —
              or just create this song without encryption for now.
            </p>
            <div className={styles.choiceActions}>
              <Link className={styles.encryptBtn} to="/login" id="encrypt-choice-signin-link">
                Sign in
              </Link>
              <button className={styles.plainBtn} onClick={choosePlain} id="encrypt-choice-plain-instead-btn">
                Don't encrypt instead
              </button>
            </div>
            <button className={styles.cancelLink} onClick={onCancel} id="encrypt-choice-cancel-btn-2">
              Cancel
            </button>
          </>
        )}

        {step === 'setup-passphrase' && (
          <>
            <h2 className={styles.title}>Set up an encryption passphrase</h2>
            <p className={styles.body}>
              This is the first song you're encrypting, so you need a passphrase. It's separate
              from your login password and <strong>never leaves your device</strong> — if you
              forget it, we cannot recover it for you (that's what makes it private).
            </p>
            <form className={styles.form} onSubmit={handlePassphraseSubmit}>
              <label className={styles.label}>
                Passphrase
                <input
                  className={styles.input}
                  type="password"
                  autoFocus
                  minLength={8}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  required
                />
              </label>
              <label className={styles.label}>
                Confirm passphrase
                <input
                  className={styles.input}
                  type="password"
                  minLength={8}
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  required
                />
              </label>
              {error && <div className={styles.errorText}>{error}</div>}
              <button className={styles.encryptBtn} type="submit" id="encrypt-setup-passphrase-continue-btn">
                Continue
              </button>
            </form>
            <button className={styles.cancelLink} onClick={onCancel} id="encrypt-choice-cancel-btn-3">
              Cancel
            </button>
          </>
        )}

        {step === 'setup-recovery' && (
          <>
            <h2 className={styles.title}>Save your recovery code</h2>
            <p className={styles.body}>
              If you ever forget your passphrase, this is the <strong>only</strong> other way
              back into your encrypted songs. Save it somewhere safe — a password manager is
              ideal. We don't keep a copy.
            </p>
            <div className={styles.recoveryCode}>{recoveryCode}</div>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
              />
              I've saved this recovery code somewhere safe.
            </label>
            {error && <div className={styles.errorText}>{error}</div>}
            <div className={styles.choiceActions}>
              <button
                className={styles.encryptBtn}
                onClick={handleFinishSetup}
                disabled={!savedConfirmed || submitting}
                id="encrypt-setup-recovery-finish-btn"
              >
                {submitting ? 'Setting up…' : 'Finish & encrypt this song'}
              </button>
            </div>
            <button className={styles.cancelLink} onClick={onCancel} id="encrypt-choice-cancel-btn-4">
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
