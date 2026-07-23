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
  const { user } = useAuth();
  const setRepo = useSongsStore((s) => s.setRepo);
  const hydrate = useSongsStore((s) => s.hydrate);

  const [phase, setPhase] = useState('checking'); // 'checking' | 'ready'

  useEffect(() => {
    let cancelled = false;

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

      await restoreSession();

      const songsAdapter = new SupabaseSongsAdapter(supabase, user.id);
      const cloudRepo = new CloudSongsRepository({ adapter: songsAdapter, userId: user.id });

      setRepo(cloudRepo);
      if (!cancelled) {
        await hydrate();
        setPhase('ready');
      }
    }

    setup();
    return () => {
      cancelled = true;
    };
  }, [user?.id, setRepo, hydrate]);

  return {
    showUnlockGate: false,
    isChecking: phase === 'checking',
  };
}
