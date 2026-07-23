import { describe, it, expect, beforeEach } from 'vitest';
import { CloudSongsRepository } from '../store/songsRepository';
import { generateContentKey } from '../crypto/envelope';
import { establishDEK, clearSession, getUnlockedSongKey } from '../crypto/keyManager';

class FakeRemoteAdapter {
  constructor() { this.rows = new Map(); }
  async list() { return [...this.rows.values()]; }
  async insert(row) { this.rows.set(row.id, row); return row; }
  async update(id, row) { this.rows.set(id, row); return row; }
  async remove(id) { this.rows.delete(id); }
}

function makeSong(overrides = {}) {
  return {
    id: 'song-1',
    title: 'Original Title',
    lines: [{ id: 'line-1', chords: 'Am', lyrics: 'original lyrics' }],
    isReadOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('per-song password lock', () => {
  let adapter;
  let repo;

  beforeEach(async () => {
    localStorage.clear();
    clearSession();
    adapter = new FakeRemoteAdapter();
    repo = new CloudSongsRepository({ adapter, userId: 'user-1', debounceMs: 50 });
    establishDEK(await generateContentKey());
  });

  it('locking an unencrypted song converts it to encrypted with the CK wrapped by the song password', async () => {
    await repo.create(makeSong(), { encrypted: false });

    await repo.lockSong('song-1', 'a-song-password');

    const row = [...adapter.rows.values()][0];
    expect(row.encrypted).toBe(true);
    expect(row.is_locked).toBe(true);
    expect(row.content.ck.wrappedBySong).toBeTruthy();
    // The plaintext title must not appear anywhere in the stored row.
    expect(JSON.stringify(row)).not.toContain('Original Title');
  });

  it('locking an already-DEK-encrypted song preserves wrappedBySong', async () => {
    await repo.create(makeSong(), { encrypted: true });
    const beforeLock = [...adapter.rows.values()][0];
    expect(beforeLock.content.ck.wrappedByDek).toBeTruthy();

    await repo.lockSong('song-1', 'a-song-password');

    const afterLock = [...adapter.rows.values()][0];
    expect(afterLock.content.ck.wrappedBySong).toBeTruthy();
  });

  it('the account DEK alone cannot read a locked song once the session key is cleared', async () => {
    await repo.create(makeSong(), { encrypted: false });
    await repo.lockSong('song-1', 'correct-password');

    clearSession(); // wipes both the DEK and the just-cached song key
    establishDEK(await generateContentKey()); // account unlocked again, but this is irrelevant to a locked song

    const [listed] = await repo.list();
    expect(listed.isUndecryptedPlaceholder).toBe(true);
  });

  it('unlockSongWithPassword decrypts with the correct password', async () => {
    await repo.create(makeSong(), { encrypted: false });
    await repo.lockSong('song-1', 'correct-password');
    clearSession();

    const unlocked = await repo.unlockSongWithPassword('song-1', 'correct-password');
    expect(unlocked.title).toBe('Original Title');
    expect(unlocked.lines[0].lyrics).toBe('original lyrics');
    expect(unlocked.isLocked).toBe(true);
    expect(getUnlockedSongKey('song-1')).toBeTruthy();
  });

  it('unlockSongWithPassword rejects the wrong password', async () => {
    await repo.create(makeSong(), { encrypted: false });
    await repo.lockSong('song-1', 'correct-password');
    clearSession();

    await expect(repo.unlockSongWithPassword('song-1', 'wrong-password')).rejects.toThrow();
    expect(getUnlockedSongKey('song-1')).toBeNull();
  });

  it('immediately blocks access after locking until unlocked with password', async () => {
    await repo.create(makeSong(), { encrypted: false });
    await repo.lockSong('song-1', 'correct-password');

    // Immediately blocked
    const [listed] = await repo.list();
    expect(listed.isUndecryptedPlaceholder).toBeTruthy();

    // Now unlock it
    await repo.unlockSongWithPassword('song-1', 'correct-password');

    const [unlocked] = await repo.list();
    expect(unlocked.isUndecryptedPlaceholder).toBeFalsy();
    expect(unlocked.title).toBe('Original Title');

    await repo.update('song-1', makeSong({
      title: 'Edited while unlocked',
      updatedAt: new Date().toISOString(), // a real edit always bumps this forward
    }));
    const row = [...adapter.rows.values()][0];
    expect(row.content.ck.wrappedBySong).toBeTruthy();

    const [relisted] = await repo.list();
    expect(relisted.title).toBe('Edited while unlocked');
  });

  it('supports repeated lock -> unlock -> lock (with a new password) cycles', async () => {
    await repo.create(makeSong(), { encrypted: false });

    await repo.lockSong('song-1', 'password-one');
    clearSession();
    await repo.unlockSongWithPassword('song-1', 'password-one');

    // Re-lock with a different password.
    await repo.lockSong('song-1', 'password-two');
    clearSession();

    await expect(repo.unlockSongWithPassword('song-1', 'password-one')).rejects.toThrow();
    const unlocked = await repo.unlockSongWithPassword('song-1', 'password-two');
    expect(unlocked.title).toBe('Original Title');
  });

  it('throws a clear error when trying to unlock a song that was never password-locked', async () => {
    await repo.create(makeSong(), { encrypted: true }); // DEK-wrapped, no song password
    await expect(repo.unlockSongWithPassword('song-1', 'anything')).rejects.toThrow(/not password-locked/);
  });
});
