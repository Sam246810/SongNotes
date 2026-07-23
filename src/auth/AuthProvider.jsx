import { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { clearSession as clearCryptoSession, establishDEK } from '../crypto/keyManager';
import { createAccountKeys, unlockWithPassphrase } from '../crypto/accountKeys';
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
      if (data?.user) {
        try {
          const keysAdapter = new SupabaseUserKeysAdapter(supabase, data.user.id);
          const { dek, envelope } = await createAccountKeys(password);
          await keysAdapter.upsert(envelope);
          establishDEK(dek);
        } catch (e) {
          console.error('Failed to setup account encryption key on signup', e);
        }
      }
      return data;
    },

    async signIn(email, password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
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
          console.error('Failed to unlock account encryption key on login', e);
        }
      }
      return data;
    },

    async signOut() {
      if (!isSupabaseConfigured) return;
      clearCryptoSession(); // wipe the in-memory DEK / unlocked song keys
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
  }), [session, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
