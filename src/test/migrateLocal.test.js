import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getLegacyLocalSongs,
  hasMigrated,
  markMigrated,
  migrateLocalSongsToCloud,
} from '../store/migrateLocal';

const LEGACY_KEY = 'songnotes_songs';
const BACKUP_KEY = 'songnotes_songs_migrated_backup';

function makeSongs() {
  return [
    { id: 'a', title: 'Song A', lines: [], isReadOnly: false, createdAt: 't', updatedAt: 't' },
    { id: 'b', title: 'Song B', lines: [], isReadOnly: false, createdAt: 't', updatedAt: 't' },
  ];
}

describe('migrateLocal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('getLegacyLocalSongs reads the legacy key, and returns [] when absent or invalid', () => {
    expect(getLegacyLocalSongs()).toEqual([]);
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeSongs()));
    expect(getLegacyLocalSongs()).toHaveLength(2);
    localStorage.setItem(LEGACY_KEY, 'not json');
    expect(getLegacyLocalSongs()).toEqual([]);
  });

  it('hasMigrated/markMigrated round-trip per user id', () => {
    expect(hasMigrated('user-1')).toBe(false);
    markMigrated('user-1');
    expect(hasMigrated('user-1')).toBe(true);
    expect(hasMigrated('user-2')).toBe(false); // scoped per user
  });

  it('imports every song via repo.create, then renames the legacy key and marks migrated', async () => {
    const songs = makeSongs();
    localStorage.setItem(LEGACY_KEY, JSON.stringify(songs));
    const create = vi.fn().mockResolvedValue(undefined);
    const repo = { create };

    await migrateLocalSongsToCloud(repo, 'user-1', songs);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, songs[0], { encrypted: false });
    expect(create).toHaveBeenNthCalledWith(2, songs[1], { encrypted: false });

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(BACKUP_KEY))).toEqual(songs);
    expect(hasMigrated('user-1')).toBe(true);
  });

  it('leaves the legacy key intact and does not mark migrated if a create fails partway', async () => {
    const songs = makeSongs();
    localStorage.setItem(LEGACY_KEY, JSON.stringify(songs));
    const create = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network down'));
    const repo = { create };

    await expect(migrateLocalSongsToCloud(repo, 'user-1', songs)).rejects.toThrow('network down');

    // Legacy key must still be there — nothing was renamed/lost.
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY))).toEqual(songs);
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull();
    expect(hasMigrated('user-1')).toBe(false);
  });

  it('deletes only matching migrated songs and leaves non-matching guest songs untouched', async () => {
    const songA = { id: 'a', title: 'Song A', lines: [], guestSessionId: 'guest-1' };
    const songB = { id: 'b', title: 'Song B', lines: [], guestSessionId: 'guest-2' };
    localStorage.setItem(LEGACY_KEY, JSON.stringify([songA, songB]));

    const create = vi.fn().mockResolvedValue(undefined);
    const repo = { create };

    // Migrate only guest-1's songs
    await migrateLocalSongsToCloud(repo, 'user-1', [songA]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ id: 'a', title: 'Song A', lines: [] }, { encrypted: false }); // guestSessionId stripped

    // Only song B should remain in localStorage
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY))).toEqual([songB]);
    expect(hasMigrated('user-1')).toBe(true);
  });
});
