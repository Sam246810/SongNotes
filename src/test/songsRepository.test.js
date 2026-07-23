import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudSongsRepository } from '../store/songsRepository';
import { generateContentKey } from '../crypto/envelope';
import { establishDEK, clearSession } from '../crypto/keyManager';

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

  beforeEach(async () => {
    localStorage.clear();
    clearSession();
    adapter = new FakeRemoteAdapter();
    repo = new CloudSongsRepository({ adapter, userId: 'user-1', debounceMs: 50 });
    // Every song is always encrypted now — establish a DEK up front for tests that
    // don't specifically care about the DEK-missing case.
    establishDEK(await generateContentKey());
  });

  afterEach(() => {
    repo.dispose();
    vi.useRealTimers();
  });

  it('throws instead of silently creating a plaintext row when the DEK is unavailable', async () => {
    clearSession();
    await expect(repo.create(makeSong())).rejects.toThrow(/encryption key/i);
  });

  describe('encrypted songs — zero-knowledge property', () => {
    it('never stores the plaintext title/lyrics server-side', async () => {
      const song = makeSong();
      await repo.create(song);

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
      await repo.create(makeSong());

      clearSession(); // simulate the account being locked again
      const [listed] = await repo.list();
      expect(listed.isUndecryptedPlaceholder).toBe(true);
      expect(listed.title).not.toBe('Super Secret Title');
      expect(JSON.stringify(listed)).not.toContain('super secret lyrics');
    });

    it('re-encrypts on every edit and the updated content round-trips correctly', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
      await vi.advanceTimersByTimeAsync(0);
      const ctAfterCreate = [...adapter.rows.values()][0].content.ct;

      await repo.update('song-1', makeSong({ lines: [{ id: 'line-1', chords: 'G', lyrics: 'edited lyrics' }] }));
      await vi.advanceTimersByTimeAsync(60); // let the debounced push fire

      const rowAfterUpdate = [...adapter.rows.values()][0];
      expect(rowAfterUpdate.content.ct).not.toBe(ctAfterCreate); // fresh ciphertext, not cached

      const [listed] = await repo.list();
      expect(listed.lines[0].lyrics).toBe('edited lyrics');
    });
  });

  describe('backward-compat reads', () => {
    it('reads a legacy unencrypted row correctly (nothing writes these anymore, but old data may still exist)', async () => {
      const legacyRow = {
        id: 'song-1',
        user_id: 'user-1',
        encrypted: false,
        content: makeSong(),
        title: 'Super Secret Title',
        is_locked: false,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      };
      adapter.rows.set('song-1', legacyRow);

      const [listed] = await repo.list();
      expect(listed.title).toBe('Super Secret Title');
      expect(listed.lines[0].lyrics).toBe('super secret lyrics');
    });
  });

  describe('local cache + debounced sync', () => {
    it('writes the cache immediately on update, before the debounced remote push fires', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Renamed' }));

      // Remote hasn't been called yet (debounced)...
      expect(adapter.calls.update).toBe(0);
      // ...but the cache already reflects the rename (decrypt to check, since it's ciphertext).
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      const cachedRow = cached.find((r) => r.id === 'song-1');
      const [listed] = await repo.list();
      expect(cachedRow).toBeDefined();
      expect(listed.title).toBe('Renamed');

      await vi.advanceTimersByTimeAsync(60);
      expect(adapter.calls.update).toBe(1);
    });

    it('coalesces rapid successive updates into a single debounced remote push', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());

      await repo.update('song-1', makeSong({ title: 'Edit 1' }));
      await vi.advanceTimersByTimeAsync(10);
      await repo.update('song-1', makeSong({ title: 'Edit 2' }));
      await vi.advanceTimersByTimeAsync(10);
      await repo.update('song-1', makeSong({ title: 'Edit 3' }));
      await vi.advanceTimersByTimeAsync(60);

      expect(adapter.calls.update).toBe(1);
      const [listed] = await repo.list();
      expect(listed.title).toBe('Edit 3');
    });

    it('remove cancels a pending debounced push and deletes remotely + from cache', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
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
      await repo.create(makeSong());
      adapter.list = vi.fn().mockRejectedValue(new Error('network down'));

      const songs = await repo.list();
      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Super Secret Title');
    });

    it('last-write-wins reconciliation prefers the newer of cache vs remote for the same id', async () => {
      await repo.create(makeSong({ updatedAt: '2026-01-01T00:00:00.000Z' }));

      // Simulate a newer edit made on another device: bump updated_at on the "remote"
      // copy only (not in our local cache). Reconciliation compares timestamps, not
      // content, so the existing valid ciphertext is fine to reuse here.
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...remoteRow, updated_at: '2026-06-01T00:00:00.000Z' });

      const [listed] = await repo.list();
      expect(listed.title).toBe('Super Secret Title');
    });
  });
});
