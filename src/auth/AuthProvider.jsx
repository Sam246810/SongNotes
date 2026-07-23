import { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { clearSession as clearCryptoSession, establishDEK } from '../crypto/keyManager';
import {
  createAccountKeys,
  unlockWithPassphrase,
  unlockWithRecoveryCode as recoverDekWithCode,
  rewrapWithNewPassphrase,
} from '../crypto/accountKeys';
import { SupabaseUserKeysAdapter } from '../lib/userKeysAdapter';
import { AuthContext } from './AuthContext';

/**
 * Wraps Supabase's auth session in React state. Automatically derives & unlocks
 * the user's account Data Encryption Key (DEK) using their account password during
 * sign in and sign up.
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
      if (data?.user) {
        try {
          const keysAdapter = new SupabaseUserKeysAdapter(supabase, data.user.id);
          const created = await createAccountKeys(password);
          await keysAdapter.upsert(created.envelope);
          establishDEK(created.dek);
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
      if (data?.user) {
        try {
          const keysAdapter = new SupabaseUserKeysAdapter(supabase, data.user.id);
          let env = await keysAdapter.get();
          if (!env) {
            const { dek, envelope } = await createAccountKeys(password);
            await keysAdapter.upsert(envelope);
            establishDEK(dek);
          } else {
            const dek = await unlockWithPassphrase(env, password);
            establishDEK(dek);
          }
        } catch (e) {
          // Wrong password would already have failed signInWithPassword above, so this
          // means the stored envelope doesn't match the current password — most likely
          // the account password was changed since encryption was set up. Surface this
          // instead of silently leaving the account's encrypted (non-locked) songs
          // unreadable with no explanation.
          console.error('Failed to unlock account encryption key on login', e);
          keyUnlockFailed = true;
        }
      }
      return { ...data, keyUnlockFailed };
    },

    /**
     * Re-derives the account DEK from `password` against the EXISTING stored envelope
     * and establishes it — no writes, no new key material. For when the DEK is simply
     * missing from this session (e.g. sessionStorage was cleared while the Supabase auth
     * session, which lives in localStorage, survived — closing and reopening the browser
     * is the common case) rather than actually mismatched. Unlike resetAccountEncryption,
     * this can't orphan any already-encrypted songs since it doesn't touch the envelope.
     */
    async unlockAccountKey(password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const currentUser = session?.user;
      if (!currentUser) throw new Error('You must be signed in to unlock encryption.');
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, currentUser.id);
      const env = await keysAdapter.get();
      if (!env) throw new Error('No account encryption key found yet.');
      const dek = await unlockWithPassphrase(env, password); // throws if password is wrong
      establishDEK(dek);
    },

    /**
     * Recovers the ORIGINAL DEK using the account's recovery code (shown once at
     * signup) rather than the password — for when the stored envelope no longer
     * matches the current login password (e.g. after a Supabase password reset).
     * Unlike resetAccountEncryption below, this doesn't mint new key material, so
     * every existing encrypted song stays readable. Also re-wraps the recovered DEK
     * under `currentPassword` and persists that, so future logins work normally via
     * password again without needing the code every time.
     */
    async unlockWithRecoveryCode(code, currentPassword) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const currentUser = session?.user;
      if (!currentUser) throw new Error('You must be signed in to recover encryption.');
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, currentUser.id);
      const env = await keysAdapter.get();
      if (!env) throw new Error('No account encryption key found yet.');
      const dek = await recoverDekWithCode(env, code); // throws if the code is wrong
      establishDEK(dek);
      const rewrapped = await rewrapWithNewPassphrase(env, dek, currentPassword);
      await keysAdapter.upsert(rewrapped);
    },

    /**
     * Re-derives the account DEK from `password` and re-wraps it fresh, overwriting the
     * stored envelope. Used as a LAST RESORT when the envelope is mismatched and the
     * recovery code isn't available — this mints a brand new DEK, so every existing
     * encrypted song becomes permanently unreadable. Prefer unlockWithRecoveryCode
     * above whenever the code is known.
     */
    async resetAccountEncryption(password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const currentUser = session?.user;
      if (!currentUser) throw new Error('You must be signed in to reset encryption.');
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, currentUser.id);
      const { dek, envelope } = await createAccountKeys(password);
      await keysAdapter.upsert(envelope);
      establishDEK(dek);
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
