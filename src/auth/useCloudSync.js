import { useEffect, useRef, useState } from 'react';
import useAuth from './useAuth';
import useSongsStore from '../store/songsStore';
import { supabase } from '../lib/supabaseClient';
import { LocalSongsRepository, CloudSongsRepository, SupabaseSongsAdapter } from '../store/songsRepository';
import { SupabaseUserKeysAdapter } from '../lib/userKeysAdapter';
import { establishDEK, isUnlocked, clearSession } from '../crypto/keyManager';

/**
 * Decides which SongsRepository the store should use and whether the passphrase
 * UnlockGate needs to be shown first, based on the current auth session:
 *
 *   - No session (guest)                    -> LocalSongsRepository, no gate.
 *   - Session, account never encrypted       -> CloudSongsRepository, no gate
 *                                               (no user_keys row => nothing to unlock).
 *   - Session, account has encrypted before  -> gate on UnlockGate; the repo is only
 *                                               bound to the store once the DEK is
 *                                               established, so the first hydrate()
 *                                               can decrypt encrypted rows immediately.
 *   - Session, already unlocked this render  -> CloudSongsRepository, no gate
 *                                               (e.g. re-entering the tree after a
 *                                               route change without a full reload).
 */
export default function useCloudSync() {
  const { user } = useAuth();
  const setRepo = useSongsStore((s) => s.setRepo);
  const hydrate = useSongsStore((s) => s.hydrate);

  const [phase, setPhase] = useState('checking'); // 'checking' | 'unlock' | 'ready'
  const [envelope, setEnvelope] = useState(null);
  const keysAdapterRef = useRef(null);
  const pendingRepoRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function setup() {
      setPhase('checking');

      if (!user) {
        clearSession();
        setRepo(new LocalSongsRepository());
        if (!cancelled) setPhase('ready');
        return;
      }

      const songsAdapter = new SupabaseSongsAdapter(supabase, user.id);
      const cloudRepo = new CloudSongsRepository({ adapter: songsAdapter, userId: user.id });
      const keysAdapter = new SupabaseUserKeysAdapter(supabase, user.id);
      keysAdapterRef.current = keysAdapter;

      if (isUnlocked()) {
        setRepo(cloudRepo);
        if (!cancelled) setPhase('ready');
        return;
      }

      try {
        const env = await keysAdapter.get();
        if (cancelled) return;
        if (!env) {
          setRepo(cloudRepo);
          setPhase('ready');
        } else {
          pendingRepoRef.current = cloudRepo;
          setEnvelope(env);
          setPhase('unlock');
        }
      } catch (e) {
        console.error('SongNotes: failed to check encryption setup', e);
        if (!cancelled) {
          setRepo(cloudRepo);
          setPhase('ready');
        }
      }
    }

    setup();
    return () => { cancelled = true; };
  }, [user, setRepo]);

  useEffect(() => {
    if (phase === 'ready') hydrate();
  }, [phase, hydrate]);

  function handleUnlock(dek) {
    establishDEK(dek);
    if (pendingRepoRef.current) setRepo(pendingRepoRef.current);
    setPhase('ready');
  }

  async function handleEnvelopeUpdated(newEnvelope) {
    if (keysAdapterRef.current) await keysAdapterRef.current.upsert(newEnvelope);
    setEnvelope(newEnvelope);
  }

  return {
    showUnlockGate: phase === 'unlock',
    isChecking: phase === 'checking',
    envelope,
    handleUnlock,
    handleEnvelopeUpdated,
  };
}
