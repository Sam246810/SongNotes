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
 * decision to encrypt). Deletes only the successfully migrated songs from the
 * legacy key, leaving other guest users' local songs intact.
 */
export async function migrateLocalSongsToCloud(repo, userId, songs) {
  for (const song of songs) {
    // Strip the guestSessionId tag when sending to the remote repository
    const { guestSessionId, ...cleanSong } = song;
    await repo.create(cleanSong, { encrypted: false });
  }

  // Backup current state
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw !== null) {
    localStorage.setItem(BACKUP_KEY, raw);
  }

  // Filter out and delete only the migrated songs
  const allSongs = getLegacyLocalSongs();
  const migratedIds = new Set(songs.map((s) => s.id));
  const remainingSongs = allSongs.filter((s) => !migratedIds.has(s.id));

  if (remainingSongs.length > 0) {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(remainingSongs));
  } else {
    localStorage.removeItem(LEGACY_KEY);
  }

  markMigrated(userId);
}
