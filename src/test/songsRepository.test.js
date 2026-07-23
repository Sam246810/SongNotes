import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudSongsRepository } from '../store/songsRepository';
import { generateContentKey } from '../crypto/envelope';
import { establishDEK, clearSession, setUnlockedSongKey } from '../crypto/keyManager';

/** In-memory stand-in for a Supabase `songs` table — no network involved. */
class FakeRemoteAdapter {
  constructor() {
    this.rows = new Map();
    this.calls = { list: 0, insert: 0, update: 0, remove: 0 };
  }
  async list() {
    this.calls.list++;
    return [...this.rows.values()];
  }
  async insert(row) {
    this.calls.insert++;
    this.rows.set(row.id, row);
    return row;
  }
  async update(id, row) {
    this.calls.update++;
    this.rows.set(id, row);
    return row;
  }
  async remove(id) {
    this.calls.remove++;
    this.rows.delete(id);
  }
}

function makeSong(overrides = {}) {
  return {
    id: 'song-1',
    title: 'Super Secret Title',
    lines: [{ id: 'line-1', chords: 'Am', lyrics: 'super secret lyrics' }],
    isReadOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('CloudSongsRepository', () => {
  let adapter;
  let repo;

  beforeEach(() => {
    localStorage.clear();
    clearSession();
    adapter = new FakeRemoteAdapter();
    repo = new CloudSongsRepository({ adapter, userId: 'user-1', debounceMs: 50 });
  });

  afterEach(() => {
    repo.dispose();
    vi.useRealTimers();
  });

  describe('unencrypted songs', () => {
    it('round-trips a plaintext song and stores it readable server-side (by design)', async () => {
      const song = makeSong();
      await repo.create(song, { encrypted: false });

      const remoteRow = [...adapter.rows.values()][0];
      expect(remoteRow.encrypted).toBe(false);
      expect(remoteRow.content.title).toBe('Super Secret Title');
      expect(remoteRow.title).toBe('Super Secret Title');

      const [listed] = await repo.list();
      expect(listed.title).toBe('Super Secret Title');
      expect(listed.lines[0].lyrics).toBe('super secret lyrics');
    });
  });

  describe('encrypted songs — zero-knowledge property', () => {
    it('never stores the plaintext title/lyrics server-side once encrypted', async () => {
      const dek = await generateContentKey();
      establishDEK(dek);

      const song = makeSong();
      await repo.create(song, { encrypted: true });

      const remoteRow = [...adapter.rows.values()][0];
      expect(remoteRow.encrypted).toBe(true);
      expect(remoteRow.title).toBeNull();
      const serializedBlob = JSON.stringify(remoteRow);
      expect(serializedBlob).not.toContain('Super Secret Title');
      expect(serializedBlob).not.toContain('super secret lyrics');

      // But it decrypts correctly for the account holder with the DEK in memory.
      const [listed] = await repo.list();
      expect(listed.title).toBe('Super Secret Title');
      expect(listed.lines[0].lyrics).toBe('super secret lyrics');
    });

    it('returns an undecryptable placeholder (not the raw ciphertext) when the DEK is missing', async () => {
      const dek = await generateContentKey();
      establishDEK(dek);
      await repo.create(makeSong(), { encrypted: true });

      clearSession(); // simulate the account being locked again
      const [listed] = await repo.list();
      expect(listed.isUndecryptedPlaceholder).toBe(true);
      expect(listed.title).not.toBe('Super Secret Title');
      expect(JSON.stringify(listed)).not.toContain('super secret lyrics');
    });

    it('reuses the same wrapped content key across content edits (does not re-wrap on every keystroke)', async () => {
      vi.useFakeTimers();
      const dek = await generateContentKey();
      establishDEK(dek);

      await repo.create(makeSong(), { encrypted: true });
      await vi.advanceTimersByTimeAsync(0);
      const rowAfterCreate = [...adapter.rows.values()][0];
      const ckAfterCreate = rowAfterCreate.content.ck.wrappedByDek.wrapped;

      await repo.update('song-1', makeSong({ lines: [{ id: 'line-1', chords: 'G', lyrics: 'edited lyrics' }] }));
      await vi.advanceTimersByTimeAsync(60); // let the debounced push fire

      const rowAfterUpdate = [...adapter.rows.values()][0];
      expect(rowAfterUpdate.content.ck.wrappedByDek.wrapped).toBe(ckAfterCreate);
      expect(rowAfterUpdate.content.contentEnvelope.ct).not.toBe(rowAfterCreate.content.contentEnvelope.ct);

      const [listed] = await repo.list();
      expect(listed.lines[0].lyrics).toBe('edited lyrics');
    });

    it('a locked song (CK wrapped by a song password, not the DEK) is unreadable without that song key even with the DEK present', async () => {
      const dek = await generateContentKey();
      establishDEK(dek);
      await repo.create(makeSong(), { encrypted: true });

      // Simulate locking: swap the cached row's ck to a song-password wrap instead of DEK.
      const cacheKey = `songnotes_cloud_cache:user-1`;
      const rows = JSON.parse(localStorage.getItem(cacheKey));
      const songKey = await generateContentKey();
      const { wrapContentKey, encryptJSON } = await import('../crypto/envelope');
      const wrappedBySong = await wrapContentKey(dek, songKey); // stand-in wrap for the test
      rows[0].content.ck = { wrappedByDek: null, wrappedBySong };
      rows[0].is_locked = true;
      rows[0].content.contentEnvelope = await encryptJSON(songKey, {
        title: 'Relocked Title', lines: [], createdAt: rows[0].created_at, updatedAt: rows[0].updated_at,
      });
      localStorage.setItem(cacheKey, JSON.stringify(rows));
      adapter.rows.set(rows[0].id, rows[0]);

      // DEK alone (account unlocked) is NOT enough — song key was never unlocked this session.
      const [lockedListed] = await repo.list();
      expect(lockedListed.isUndecryptedPlaceholder).toBe(true);

      // Once the song key is unlocked for this session, it decrypts.
      setUnlockedSongKey('song-1', songKey);
      const [unlockedListed] = await repo.list();
      expect(unlockedListed.title).toBe('Relocked Title');
    });
  });

  describe('local cache + debounced sync', () => {
    it('writes the cache immediately on update, before the debounced remote push fires', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong(), { encrypted: false });
      await repo.update('song-1', makeSong({ title: 'Renamed' }));

      // Remote hasn't been called yet (debounced)...
      expect(adapter.calls.update).toBe(0);
      // ...but the cache already reflects the rename.
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      expect(cached.find((r) => r.id === 'song-1').content.title).toBe('Renamed');

      await vi.advanceTimersByTimeAsync(60);
      expect(adapter.calls.update).toBe(1);
    });

    it('coalesces rapid successive updates into a single debounced remote push', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong(), { encrypted: false });

      await repo.update('song-1', makeSong({ title: 'Edit 1' }));
      await vi.advanceTimersByTimeAsync(10);
      await repo.update('song-1', makeSong({ title: 'Edit 2' }));
      await vi.advanceTimersByTimeAsync(10);
      await repo.update('song-1', makeSong({ title: 'Edit 3' }));
      await vi.advanceTimersByTimeAsync(60);

      expect(adapter.calls.update).toBe(1);
      expect(adapter.rows.get('song-1').content.title).toBe('Edit 3');
    });

    it('remove cancels a pending debounced push and deletes remotely + from cache', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong(), { encrypted: false });
      await repo.update('song-1', makeSong({ title: 'About to be deleted' }));

      await repo.remove('song-1');
      await vi.advanceTimersByTimeAsync(100);

      expect(adapter.calls.update).toBe(0); // pending push was cancelled, not fired
      expect(adapter.calls.remove).toBe(1);
      expect(adapter.rows.has('song-1')).toBe(false);
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      expect(cached.find((r) => r.id === 'song-1')).toBeUndefined();
    });

    it('falls back to the local cache when the remote list() call fails (offline)', async () => {
      await repo.create(makeSong(), { encrypted: false });
      adapter.list = vi.fn().mockRejectedValue(new Error('network down'));

      const songs = await repo.list();
      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Super Secret Title');
    });

    it('last-write-wins reconciliation prefers the newer of cache vs remote for the same id', async () => {
      await repo.create(makeSong({ updatedAt: '2026-01-01T00:00:00.000Z' }), { encrypted: false });

      // Simulate a newer edit made on another device (only in "remote", not in our cache).
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', {
        ...remoteRow,
        content: { ...remoteRow.content, title: 'Edited elsewhere' },
        updated_at: '2026-06-01T00:00:00.000Z',
      });

      const [listed] = await repo.list();
      expect(listed.title).toBe('Edited elsewhere');
    });
  });
});
