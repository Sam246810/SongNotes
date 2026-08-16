import { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { clearSession as clearCryptoSession, establishDEK } from '../crypto/keyManager';
import { createAccountKeys, unlockWithPassphrase, migrateWrapIfNeeded } from '../crypto/accountKeys';
import { SupabaseUserKeysAdapter } from '../lib/userKeysAdapter';
import { AuthContext } from './AuthContext';

/** Postgres unique_violation — see signIn's create-if-missing branch below. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Wraps Supabase's auth session in React state. Automatically derives & unlocks
 * the user's account Data Encryption Key (DEK) using their account password during
 * sign in and sign up.
 *
 * Forgot-password / recovery-code recovery lives in accountRecovery.js instead of
 * here — it's a state machine with no dependency on React's session state (the
 * reset-password page in particular runs against a Supabase *recovery* session
 * this provider doesn't specially model), so ResetPasswordPage/LoginPage/AccountPage
 * import it directly rather than going through this context.
 */
export default function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  const value = useMemo(() => ({
    configured: isSupabaseConfigured,
    session,
    user: session?.user ?? null,
    loading,

    async signUp(email, password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      let recoveryCode = null;
      // With email confirmation enabled, signUp() returns a user but NO session —
      // any write attempted here would fail Row Level Security (silently caught
      // below), leaving a recovery code nobody ever sees and an envelope wrap
      // whose secret is gone forever. Only attempt key setup with a real session;
      // the first post-confirmation SIGN-IN (see the `!env` branch below) mints
      // and surfaces the code instead.
      if (data?.user && data?.session) {
        try {
          const keysAdapter = new SupabaseUserKeysAdapter(supabase, data.user.id);
          const created = await createAccountKeys(password);
          await keysAdapter.create(created.envelope);
          await establishDEK(created.dek, data.user.id, created.envelope.dekId);
          recoveryCode = created.recoveryCode;
        } catch (e) {
          console.error('Failed to setup account encryption key on signup', e);
        }
      }
      return { ...data, recoveryCode };
    },

    async signIn(email, password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      let keyUnlockFailed = false;
      let recoveryCode = null;
      if (data?.user) {
        const keysAdapter = new SupabaseUserKeysAdapter(supabase, data.user.id);

        // Fetching the envelope row is infrastructure (network/schema/RLS), not
        // a password check -- a failure here must NOT be folded into
        // keyUnlockFailed below. Not hypothetical: a missing `envelope_rev`
        // column on the live database once made this exact fetch fail for
        // every account, and every sign-in showed "your saved encryption key
        // doesn't match this password" -- actively false, and it sent people
        // toward entering a recovery code that could never have helped, since
        // nothing was wrong with their password OR their envelope.
        let current;
        try {
          current = await keysAdapter.get();
        } catch (fetchError) {
          console.error('Failed to fetch account encryption key on login (infrastructure, not a password issue)', fetchError);
          throw new Error(
            "Signed in, but couldn't reach your account's encryption key. " +
            "This isn't a wrong-password issue — try again in a moment."
          );
        }

        try {
          if (!current) {
            // First sign-in for an account with no envelope yet (e.g. the
            // confirm-email gap above, or any legacy account). `.create()` — not
            // a blind upsert — so a concurrent creator (another tab, a race with
            // signup's own write) is detected via 23505 rather than silently
            // overwritten: that would mint a brand-new DEK over a live one and
            // permanently orphan every song already encrypted under it.
            const created = await createAccountKeys(password);
            try {
              await keysAdapter.create(created.envelope);
              await establishDEK(created.dek, data.user.id, created.envelope.dekId);
              recoveryCode = created.recoveryCode; // surfaced — this used to be silently discarded
            } catch (createError) {
              if (createError?.code === PG_UNIQUE_VIOLATION) {
                // Someone else created it first between our get() and this
                // insert — re-read and unlock against THEIRS, not our own
                // now-orphaned DEK.
                const raced = await keysAdapter.get();
                if (!raced) throw createError; // shouldn't happen; don't swallow
                const racedDek = await unlockWithPassphrase(raced.envelope, password);
                await establishDEK(racedDek, data.user.id, raced.envelope.dekId);
              } else {
                throw createError;
              }
            }
          } else {
            const dek = await unlockWithPassphrase(current.envelope, password);
            await establishDEK(dek, data.user.id, current.envelope.dekId);
            // Best-effort: rewrap the passphrase wrap onto the current KDF policy
            // (Argon2id) if it's still on PBKDF2. Never blocks sign-in — the DEK
            // is already established above regardless of whether this persist
            // succeeds. A rev conflict here (another tab/device wrote first) is
            // just as harmless to skip as any other failure — the migration will
            // simply retry on a later sign-in.
            try {
              const { envelope: migratedEnv, migrated } = await migrateWrapIfNeeded(current.envelope, 'passphrase', password, dek);
              if (migrated) await keysAdapter.update(migratedEnv, current.rev);
            } catch (migrateError) {
              console.error('Failed to migrate account encryption key to current KDF policy', migrateError);
            }
          }
        } catch (e) {
          // Wrong password would already have failed signInWithPassword above, so this
          // means the stored envelope doesn't match the current password — most likely
          // the account password was changed since encryption was set up (including via
          // a forgot-password reset that didn't complete — see accountRecovery.js).
          // Surface this instead of silently leaving the account's encrypted songs
          // unreadable with no explanation.
          console.error('Failed to unlock account encryption key on login', e);
          keyUnlockFailed = true;
        }
      }
      return { ...data, keyUnlockFailed, recoveryCode };
    },

    /**
     * Re-derives the account DEK from `password` against the EXISTING stored envelope
     * and establishes it — no writes, no new key material. For when the DEK is simply
     * missing from this session (e.g. sessionStorage was cleared while the Supabase auth
     * session, which lives in localStorage, survived — closing and reopening the browser
     * is the common case) rather than actually mismatched. Unlike accountRecovery.js's
     * flows, this can't orphan any already-encrypted songs since it doesn't touch the envelope.
     */
    async unlockAccountKey(password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const currentUser = session?.user;
      if (!currentUser) throw new Error('You must be signed in to unlock encryption.');
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, currentUser.id);

      // Same distinction as signIn above: fetching the row is infrastructure,
      // not a password check. Callers (PrivacyScreen, Editor.jsx's
      // AccountKeyGate) show err.message directly, so this must read clearly
      // on its own rather than being swallowed into a blanket "wrong password".
      let current;
      try {
        current = await keysAdapter.get();
      } catch (fetchError) {
        console.error('Failed to fetch account encryption key (infrastructure, not a password issue)', fetchError);
        throw new Error(
          "Couldn't reach your account's encryption key. This isn't a wrong-password issue — try again in a moment."
        );
      }
      if (!current) throw new Error('No account encryption key found yet.');

      try {
        const dek = await unlockWithPassphrase(current.envelope, password);
        await establishDEK(dek, currentUser.id, current.envelope.dekId);
      } catch {
        throw new Error('Incorrect password.');
      }
    },

    /** Sends a Supabase password-reset email — see ForgotPasswordPage. */
    async requestPasswordReset(email) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
    },

    async signOut() {
      if (!isSupabaseConfigured) return;
      clearCryptoSession(); // wipe the in-memory DEK
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  }), [session, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
