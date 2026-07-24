import { useEffect, useState } from 'react';
import useAuth from './useAuth';
import useSongsStore from '../store/songsStore';
import { CloudSongsRepository } from '../store/songsRepository';
import { getLegacyLocalSongs, hasMigrated, markMigrated, migrateLocalSongsToCloud } from '../store/migrateLocal';

/**
 * Offers to import a guest's pre-existing local songs into their account, once,
 * the first time they're signed in with the cloud repo hydrated. Declining still
 * marks it done — this is a one-time offer per account, not a nag on every login.
 *
 * Security: Only offers migration if those local songs were created/edited
 * in the active guest session (using transient sessionStorage guest id).
 */
export default function useLocalMigration() {
  const { user } = useAuth();
  const status = useSongsStore((s) => s.status);
  const repo = useSongsStore((s) => s.repo);
  const hydrate = useSongsStore((s) => s.hydrate);

  const [legacySongs, setLegacySongs] = useState([]);
  const [show, setShow] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user || status !== 'ready' || !(repo instanceof CloudSongsRepository)) {
      setShow(false);
      return;
    }
    if (hasMigrated(user.id)) {
      setShow(false);
      return;
    }

    // Only offer to migrate if there is an active guest session ID in this tab
    const activeGuestId = sessionStorage.getItem('__songnotes_guest_session_id');
    if (!activeGuestId) {
      markMigrated(user.id);
      setShow(false);
      return;
    }

    const songs = getLegacyLocalSongs().filter((s) => s.guestSessionId === activeGuestId);
    if (songs.length === 0) {
      markMigrated(user.id); // nothing to ever offer for this account
      setShow(false);
      return;
    }
    setLegacySongs(songs);
    setShow(true);
  }, [user, status, repo]);

  async function handleImport() {
    setImporting(true);
    setError(null);
    try {
      await migrateLocalSongsToCloud(repo, user.id, legacySongs);
      setShow(false);
      await hydrate();
    } catch (err) {
      setError(err.message || 'Failed to import your local songs. You can try again later.');
    } finally {
      setImporting(false);
    }
  }

  function handleDismiss() {
    if (user) markMigrated(user.id);
    setShow(false);
  }

  return { show, count: legacySongs.length, importing, error, handleImport, handleDismiss };
}
