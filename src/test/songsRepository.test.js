import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudSongsRepository } from '../store/songsRepository';
import { generateContentKey, decryptJSON, encryptJSON } from '../crypto/envelope';
import { establishDEK, clearSession, getDEK } from '../crypto/keyManager';

/** In-memory stand-in for a Supabase `songs` table — no network involved. */
class FakeRemoteAdapter {
  constructor() {
    this.rows = new Map();
    this.calls = { list: 0, insert: 0, updateWithRevCheck: 0 };
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
  /** Mirrors SupabaseSongsAdapter's `WHERE id = ? AND rev = ?` conditional update. */
  async updateWithRevCheck(id, row, expectedRev) {
    this.calls.updateWithRevCheck++;
    const current = this.rows.get(id);
    if (!current || current.rev !== expectedRev) return { conflict: true };
    this.rows.set(id, row);
    return { conflict: false, row };
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
      expect('title' in remoteRow).toBe(false); // no title column at all anymore, not even null
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

  describe('wire-format v2: chords stored as anchors, not the padded editing string', () => {
    it('stores chords[] as {i,c} anchors in the encrypted content, not the padded string', async () => {
      const song = makeSong({
        lines: [{ id: 'line-1', chords: 'G          C', lyrics: 'Amazing grace, how sweet' }],
      });
      await repo.create(song);

      const dek = getDEK();
      const remoteRow = [...adapter.rows.values()][0];
      const decryptedContent = await decryptJSON(dek, remoteRow.content);
      expect(decryptedContent.lines[0].chords).toEqual([{ i: 0, c: 'G' }, { i: 11, c: 'C' }]);

      // The app-facing Song object gets a padded string back (re-aligned to the
      // lyrics length via alignChordsWithLyrics, same as everywhere else in the
      // app) -- callers (the editor, transpose, etc.) never need to know storage
      // uses anchors, just that G is at column 0 and C is at column 11.
      const [listed] = await repo.list();
      expect(listed.lines[0].chords.slice(0, 12)).toBe('G          C');
      expect(listed.lines[0].chords.length).toBeGreaterThanOrEqual(song.lines[0].lyrics.length);
    });

    it('round-trips a chord placed past the end of a short lyric line (valid per wire-format §4)', async () => {
      const song = makeSong({
        lines: [{ id: 'line-1', chords: '          Dsus4', lyrics: 'Oh' }],
      });
      await repo.create(song);
      const [listed] = await repo.list();
      expect(listed.lines[0].chords).toBe('          Dsus4');
    });

    it('round-trips an all-instrumental line with empty lyrics', async () => {
      const song = makeSong({ lines: [{ id: 'line-1', chords: 'G   C   D', lyrics: '' }] });
      await repo.create(song);
      const [listed] = await repo.list();
      expect(listed.lines[0].chords.trim().split(/\s+/)).toEqual(['G', 'C', 'D']);
    });

    it('reads a real pre-existing encrypted row whose content still has the old padded-string chords (written before this conversion existed)', async () => {
      const dek = getDEK();
      const legacyContent = await encryptJSON(dek, {
        title: 'Old Song',
        lines: [{ id: 'line-1', chords: 'Am    G', lyrics: 'a lyric from before the fix' }],
        bpm: 0, key: '', tuning: '', capo: 0, customChords: undefined,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      adapter.rows.set('old-song', {
        id: 'old-song', user_id: 'user-1', encrypted: true, content: legacyContent,
        is_locked: false, rev: 1, deleted_at: null,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      });

      const songs = await repo.list();
      const listed = songs.find((s) => s.id === 'old-song');
      expect(listed.title).toBe('Old Song');
      expect(listed.lines[0].chords.slice(0, 7)).toBe('Am    G');
    });
  });

  describe('local cache + debounced sync', () => {
    it('writes the cache immediately on update, before the debounced remote push fires', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Renamed' }));

      // Remote hasn't been called yet (debounced)...
      expect(adapter.calls.updateWithRevCheck).toBe(0);
      // ...but the cache already reflects the rename (decrypt to check, since it's ciphertext).
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      const cachedRow = cached.find((r) => r.id === 'song-1');
      const [listed] = await repo.list();
      expect(cachedRow).toBeDefined();
      expect(listed.title).toBe('Renamed');

      await vi.advanceTimersByTimeAsync(60);
      expect(adapter.calls.updateWithRevCheck).toBe(1);
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

      expect(adapter.calls.updateWithRevCheck).toBe(1);
      const [listed] = await repo.list();
      expect(listed.title).toBe('Edit 3');
    });

    it('remove cancels a pending debounced push and tombstones the row remotely + in cache', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'About to be deleted' }));

      await repo.remove('song-1');
      await vi.advanceTimersByTimeAsync(100);

      // Only the tombstone write happened -- the pending edit's push was cancelled, not fired.
      expect(adapter.calls.updateWithRevCheck).toBe(1);
      expect(adapter.rows.get('song-1').deleted_at).not.toBeNull();

      // A tombstone is a soft delete, not a real DELETE -- the row still exists (for other
      // devices' reconciliation to see), it's just never shown to the user.
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      expect(cached.find((r) => r.id === 'song-1').deleted_at).not.toBeNull();
      const songs = await repo.list();
      expect(songs.find((s) => s.id === 'song-1')).toBeUndefined();
    });

    it('falls back to the local cache when the remote list() call fails (offline)', async () => {
      await repo.create(makeSong());
      adapter.list = vi.fn().mockRejectedValue(new Error('network down'));

      const songs = await repo.list();
      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Super Secret Title');
    });

    it('rev-based reconciliation prefers the higher rev between cache and remote for the same id', async () => {
      await repo.create(makeSong());

      // Simulate a newer edit made on another device: bump rev on the "remote" copy
      // only (not in our local cache). Reconciliation compares rev -- coordinated via
      // updateWithRevCheck's optimistic-concurrency check, unlike wall-clock
      // updated_at, which is vulnerable to clock skew between devices.
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...remoteRow, rev: remoteRow.rev + 1 });

      const [listed] = await repo.list();
      expect(listed.title).toBe('Super Secret Title');
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      expect(cached.find((r) => r.id === 'song-1').rev).toBe(remoteRow.rev + 1);
    });
  });

  describe('sync-v2 (Tier 0): rev, tombstones, conflict copies', () => {
    it('a delete on another device propagates: list() hides the song once its remote row is tombstoned', async () => {
      // "Another device" deletes song-1 -- simulated directly against the fake
      // remote, bypassing this repo instance entirely, same as a real second client
      // would only ever be visible through the remote row, never this cache.
      await repo.create(makeSong());
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...remoteRow, deleted_at: new Date().toISOString(), rev: remoteRow.rev + 1 });

      const songs = await repo.list();
      expect(songs.find((s) => s.id === 'song-1')).toBeUndefined();
    });

    it('a losing optimistic-concurrency race keeps the edit as a new conflict-copy song instead of dropping it', async () => {
      // Real timers here, not fake -- the conflict path chains a second real
      // async encryptJSON call (for the conflict copy) after the failed push, and
      // advanceTimersByTimeAsync's microtask flushing isn't reliably deep enough
      // for that extra hop; a short real wait is simpler and just as fast.
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'My Local Edit' }));

      // Before this device's debounced push fires, "another device" wins the race:
      // writes directly to the fake remote with the same expected rev, bumping rev.
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...remoteRow, rev: remoteRow.rev + 1 });

      await new Promise((resolve) => setTimeout(resolve, 150)); // let this device's now-stale push fire and lose

      // The original row is untouched by the loser -- still whatever "another device" wrote.
      expect(adapter.rows.get('song-1').rev).toBe(remoteRow.rev + 1);
      // But this device's edit was NOT silently dropped -- it landed as a new row.
      expect(adapter.rows.size).toBe(2);
      const conflictRow = [...adapter.rows.values()].find((r) => r.id !== 'song-1');
      expect(conflictRow).toBeDefined();
      expect(conflictRow.rev).toBe(1);

      const songs = await repo.list();
      const conflictSong = songs.find((s) => s.id === conflictRow.id);
      expect(conflictSong.title).toMatch(/^My Local Edit \(conflict copy — .+, \d{1,2}:\d{2}.*\)$/);
    });
  });
});
