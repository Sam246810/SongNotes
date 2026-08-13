import { useEffect, useState } from 'react';
import useAuth from './useAuth';
import useSongsStore from '../store/songsStore';
import { supabase } from '../lib/supabaseClient';
import { LocalSongsRepository, CloudSongsRepository, SupabaseSongsAdapter } from '../store/songsRepository';
import { clearSession, restoreSession } from '../crypto/keyManager';

/**
 * Binds the right SongsRepository (local for guests, cloud for signed-in accounts)
 * based on the current auth session.
 */
export default function useCloudSync() {
  const { user, loading: authLoading } = useAuth();
  const setRepo = useSongsStore((s) => s.setRepo);
  const hydrate = useSongsStore((s) => s.hydrate);

  const [phase, setPhase] = useState('checking'); // 'checking' | 'ready'

  useEffect(() => {
    // AuthProvider's session starts null and is only known for sure once `loading`
    // flips false — on every fresh page load `user` is transiently null while that
    // restores. Acting on it as "signed out" here would call clearSession() and wipe
    // the sessionStorage-persisted DEK before the real (signed-in) session even
    // arrives, permanently breaking decryption for DEK-only encrypted songs on every
    // reload. Wait for the real answer instead of the transient one.
    if (authLoading) return undefined;

    let cancelled = false;
    // The CloudSongsRepository instance THIS effect run creates, if any — tracked
    // locally (not from the store) so the cleanup below disposes exactly the
    // instance it made, never a newer one a later run already installed.
    let createdRepo = null;

    async function setup() {
      setPhase('checking');

      if (!user) {
        clearSession();
        setRepo(new LocalSongsRepository());
        if (!cancelled) {
          await hydrate();
          setPhase('ready');
        }
        return;
      }

      await restoreSession(user.id);

      const songsAdapter = new SupabaseSongsAdapter(supabase, user.id);
      const cloudRepo = new CloudSongsRepository({ adapter: songsAdapter, userId: user.id });
      createdRepo = cloudRepo;

      setRepo(cloudRepo);
      if (!cancelled) {
        await hydrate();
        setPhase('ready');
      }
    }

    setup();
    return () => {
      cancelled = true;
      // dispose() removes the repo's `beforeunload` flush listener -- without
      // this the listener leaked across every account switch/reconnect in this
      // tab, and an old instance still holding rows encrypted under a since-
      // rotated DEK could flush a stale write on a later unload.
      createdRepo?.dispose();
    };
  }, [user?.id, authLoading, setRepo, hydrate]);

  return {
    showUnlockGate: false,
    isChecking: phase === 'checking' || authLoading,
  };
}
