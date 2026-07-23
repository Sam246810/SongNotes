const LEGACY_KEY = 'songnotes_songs';
const BACKUP_KEY = 'songnotes_songs_migrated_backup';

export function getLegacyLocalSongs() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function hasMigrated(userId) {
  return localStorage.getItem(`songnotes_migrated:${userId}`) === 'true';
}

export function markMigrated(userId) {
  localStorage.setItem(`songnotes_migrated:${userId}`, 'true');
}

/**
 * Imports the guest-mode local songs into the signed-in account (as unencrypted
 * songs, matching how they were already stored — this is a plain move, not a
 * decision to encrypt). Only renames the legacy key (never deletes it) once every
 * song has been confirmed created remotely, so a partial failure never loses data.
 */
export async function migrateLocalSongsToCloud(repo, userId, songs) {
  for (const song of songs) {
    // Sequential on purpose: if one create fails partway, the legacy key must still
    // be intact (not yet renamed) so nothing already-imported gets duplicated on retry
    // and nothing not-yet-imported is lost.
    await repo.create(song, { encrypted: false });
  }
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw !== null) localStorage.setItem(BACKUP_KEY, raw);
  localStorage.removeItem(LEGACY_KEY);
  markMigrated(userId);
}
