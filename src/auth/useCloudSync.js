import { useEffect, useState } from 'react';
import useAuth from './useAuth';
import useSongsStore from '../store/songsStore';
import { supabase } from '../lib/supabaseClient';
import { LocalSongsRepository, CloudSongsRepository, SupabaseSongsAdapter } from '../store/songsRepository';
import { clearSession, restoreSession } from '../crypto/keyManager';

// While signed in, the store re-pulls from the server when the window regains
// focus or the tab is shown again, and on this interval while it's visible --
// the Android app only syncs when its Sync button is pressed, so an open tab
// otherwise never sees those edits. Each refresh is one `select` of the
// user's rows; MIN_REFRESH_GAP_MS keeps focus + visibilitychange (which
// usually fire together) and the interval from stacking up.
export const REFRESH_INTERVAL_MS = 60_000;
const MIN_REFRESH_GAP_MS = 5_000;

/**
 * Calls `refresh` on window focus, on the tab becoming visible, and every
 * REFRESH_INTERVAL_MS while visible, at most once per MIN_REFRESH_GAP_MS.
 * Returns a function that removes all of it.
 */
export function startForegroundRefresh(refresh) {
  let last = Date.now(); // just hydrated
  const maybeRefresh = () => {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - last < MIN_REFRESH_GAP_MS) return;
    last = Date.now();
    refresh();
  };
  window.addEventListener('focus', maybeRefresh);
  document.addEventListener('visibilitychange', maybeRefresh);
  const interval = setInterval(maybeRefresh, REFRESH_INTERVAL_MS);
  return () => {
    window.removeEventListener('focus', maybeRefresh);
    document.removeEventListener('visibilitychange', maybeRefresh);
    clearInterval(interval);
  };
}

/**
 * Binds the right SongsRepository (local for guests, cloud for signed-in accounts)
 * based on the current auth session.
 */
export default function useCloudSync() {
  const { user, loading: authLoading } = useAuth();
  const setRepo = useSongsStore((s) => s.setRepo);
  const hydrate = useSongsStore((s) => s.hydrate);
  const refresh = useSongsStore((s) => s.refresh);

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
    let stopRefresh = null;

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
      if (!cancelled) stopRefresh = startForegroundRefresh(refresh);
    }

    setup();
    return () => {
      cancelled = true;
      stopRefresh?.();
      // dispose() removes the repo's `beforeunload` flush listener -- without
      // this the listener leaked across every account switch/reconnect in this
      // tab, and an old instance still holding rows encrypted under a since-
      // rotated DEK could flush a stale write on a later unload.
      createdRepo?.dispose();
    };
  }, [user?.id, authLoading, setRepo, hydrate, refresh]);

  return {
    showUnlockGate: false,
    isChecking: phase === 'checking' || authLoading,
  };
}
