import { useEffect, useMemo, useState } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabaseClient';
import { clearSession as clearCryptoSession } from '../crypto/keyManager';
import { AuthContext } from './AuthContext';

/**
 * Wraps Supabase's auth session in React state. When Supabase isn't configured
 * (no VITE_SUPABASE_URL/ANON_KEY — e.g. a fresh checkout before the user has set up
 * their own free project), auth is simply unavailable and the app runs guest-only;
 * nothing here throws.
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
      return data;
    },

    async signIn(email, password) {
      if (!isSupabaseConfigured) throw new Error('Accounts are not configured for this deployment.');
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
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
