import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CloudSongsRepository } from '../store/songsRepository';
import { generateContentKey, decryptJSON, encryptJSON } from '../crypto/envelope';
import { establishDEK, clearSession, getDEK } from '../crypto/keyManager';

/** In-memory stand-in for a Supabase `songs` table — no network involved. */
class FakeRemoteAdapter {
  constructor() {
    this.rows = new Map();
    this.calls = { list: 0, getById: 0, insert: 0, updateWithRevCheck: 0 };
  }
  async list() {
    this.calls.list++;
    return [...this.rows.values()];
  }
  async getById(id) {
    this.calls.getById++;
    return this.rows.get(id) ?? null;
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
    lines: [{ id: 'line-1', chords: [{ i: 0, c: 'Am' }], lyrics: 'super secret lyrics' }],
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

    it('stamps dek_id on the row from the active session', async () => {
      clearSession();
      await establishDEK(await generateContentKey(), 'user-1', 'dek-abc');
      await repo.create(makeSong());
      const remoteRow = [...adapter.rows.values()][0];
      expect(remoteRow.dek_id).toBe('dek-abc');
    });

    it('shows a distinct "previous key" placeholder after a DEK rotation, without attempting to decrypt', async () => {
      clearSession();
      await establishDEK(await generateContentKey(), 'user-1', 'dek-old');
      await repo.create(makeSong());

      // Simulate rotateAndPurge's aftermath on a device that hasn't synced the
      // purge yet: a fresh DEK/dekId is active, but this row is still around
      // (e.g. synced from another device in the gap) encrypted under the old one.
      clearSession();
      await establishDEK(await generateContentKey(), 'user-1', 'dek-new');

      const [listed] = await repo.list();
      expect(listed.isUndecryptedPlaceholder).toBe(true);
      expect(listed.isFromPreviousKey).toBe(true);
      expect(listed.title).toBe('🔒 Encrypted under a previous key');
    });

    it('re-encrypts on every edit and the updated content round-trips correctly', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
      await vi.advanceTimersByTimeAsync(0);
      const ctAfterCreate = [...adapter.rows.values()][0].content.ct;

      await repo.update('song-1', makeSong({ lines: [{ id: 'line-1', chords: [{ i: 0, c: 'G' }], lyrics: 'edited lyrics' }] }));
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

  describe('wire-format v2: lines are stored as the app holds them', () => {
    it('stores chords[] as {i,c} anchors in the encrypted content, and reads them back unchanged', async () => {
      const song = makeSong({
        lines: [{ id: 'line-1', chords: [{ i: 0, c: 'G' }, { i: 11, c: 'C' }], lyrics: 'Amazing grace, how sweet' }],
      });
      await repo.create(song);

      const dek = getDEK();
      const remoteRow = [...adapter.rows.values()][0];
      const decryptedContent = await decryptJSON(dek, remoteRow.content);
      expect(decryptedContent.lines).toEqual(song.lines);

      const [listed] = await repo.list();
      expect(listed.lines).toEqual(song.lines);
    });

    it('round-trips a paragraph-length line whole, with chords on what would be different wrapped rows', async () => {
      // A chord ending one row and a chord starting the next overlap if the
      // paragraph's chords are ever flattened into one padded string; as
      // anchors they never meet, so nothing moves or merges on save + reopen.
      const lyrics = 'the quick brown fox jumps over the lazy dog and keeps on running far away';
      const chords = [{ i: 8, c: 'Am' }, { i: 10, c: 'G' }, { i: 40, c: 'Dsus4' }];
      await repo.create(makeSong({ lines: [{ id: 'line-1', lyrics, chords }] }));
      const [listed] = await repo.list();
      expect(listed.lines).toEqual([{ id: 'line-1', lyrics, chords }]);
    });

    it('round-trips a chord placed past the end of a short lyric line (valid per wire-format §4)', async () => {
      const song = makeSong({ lines: [{ id: 'line-1', chords: [{ i: 10, c: 'Dsus4' }], lyrics: 'Oh' }] });
      await repo.create(song);
      const [listed] = await repo.list();
      expect(listed.lines[0].chords).toEqual([{ i: 10, c: 'Dsus4' }]);
    });

    it('round-trips an all-instrumental line with empty lyrics', async () => {
      const chords = [{ i: 0, c: 'G' }, { i: 4, c: 'C' }, { i: 8, c: 'D' }];
      const song = makeSong({ lines: [{ id: 'line-1', chords, lyrics: '' }] });
      await repo.create(song);
      const [listed] = await repo.list();
      expect(listed.lines[0].chords).toEqual(chords);
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
      expect(listed.lines[0].chords).toEqual([{ i: 0, c: 'Am' }, { i: 6, c: 'G' }]);
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
      // flushPending(), not a timer wait of any kind -- it clears the debounce timer
      // and awaits _pushOne (and, on a lost race, _writeConflictCopy's own async chain)
      // directly, so the push and its conflict-copy fallback are done by the time this
      // await returns. No race against wall-clock time to get right.
      //
      // This used to be `await new Promise(r => setTimeout(r, 150))`, betting that a
      // 150ms real wait was always enough to outlast the 50ms debounce plus the
      // conflict-copy's own async hop. It was flaky under load: a slow/throttled
      // CI environment (this repo saw one test run take environment:206s against a
      // normal ~30s) can make even a "3x margin" wait insufficient, and a fixed sleep
      // has no way to detect that it wasn't -- the test just asserts on whatever state
      // happened to exist when the timer fired, race lost or not. flushPending()
      // removes the race structurally instead of widening the margin on a guess.
      //
      // fake timers were tried and rejected for this same reason, for the opposite
      // failure mode: vi.advanceTimersByTimeAsync's microtask flushing isn't reliably
      // deep enough to drain the conflict path's extra real async hop, so it could
      // under-run instead. flushPending() sidesteps timers, real or fake, entirely.
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'My Local Edit' }));

      // Before this device's debounced push fires, "another device" wins the race:
      // writes directly to the fake remote with the same expected rev, bumping rev.
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...remoteRow, rev: remoteRow.rev + 1 });

      await repo.flushPending(); // let this device's now-stale push fire and lose

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

  describe('conflict resolution: the song goes back to the server version', () => {
    // "Another device": its own cache, same account DEK, same server.
    function otherDevice() {
      return new CloudSongsRepository({ adapter, userId: 'user-1', cacheKey: 'other-device-cache', debounceMs: 50 });
    }

    async function loseARace() {
      await repo.create(makeSong());
      await repo.list();
      const other = otherDevice();
      await other.list();
      await repo.update('song-1', makeSong({ title: 'My Local Edit' }));
      // Two saves there, so the server's rev (3) is past the one this device's
      // optimistic cache row holds (2) -- with that row left in place, every
      // later save here expected rev 2 and lost again.
      await other.update('song-1', makeSong({ title: 'Their first edit' }));
      await other.flushPending();
      await other.update('song-1', makeSong({ title: 'Their Edit' }));
      await other.flushPending();
      await repo.flushPending(); // loses: the server is at rev 3 already
      other.dispose();
    }

    it('two conflicting edits in a row create exactly one conflict copy', async () => {
      await loseARace();
      expect(adapter.rows.size).toBe(2);

      // The next edits are made on the version that won -- the store shows it
      // now -- and have to land on top of it rather than lose the same race again.
      await repo.update('song-1', makeSong({ title: 'Their Edit, then mine' }));
      await repo.flushPending();
      await repo.update('song-1', makeSong({ title: 'And another' }));
      await repo.flushPending();

      expect(adapter.rows.size).toBe(2);
      const titles = (await repo.list()).map((s) => s.title).sort();
      expect(titles).toHaveLength(2);
      expect(titles[0]).toBe('And another');
      expect(titles[1]).toMatch(/^My Local Edit \(conflict copy — /);
      expect(adapter.rows.get('song-1').rev).toBe(5);
    });

    it('writes the winning server row into the cache and reports it, with the copy, to listeners', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await loseARace();

      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1')).find((r) => r.id === 'song-1');
      expect(cached).toEqual(adapter.rows.get('song-1'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('conflict');
      expect(events[0].songId).toBe('song-1');
      expect(events[0].current.title).toBe('Their Edit');
      expect(events[0].copy.title).toMatch(/^My Local Edit \(conflict copy — /);
      expect(adapter.rows.has(events[0].copy.id)).toBe(true);
    });

    it('puts edits made while the losing push was out into the copy, not over the winner', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'First keystroke' }));
      adapter.rows.set('song-1', { ...adapter.rows.get('song-1'), rev: 2 });

      const realUpdate = adapter.updateWithRevCheck.bind(adapter);
      adapter.updateWithRevCheck = async (...args) => {
        await repo.update('song-1', makeSong({ title: 'Second keystroke' })); // typed mid-push
        return realUpdate(...args);
      };
      await repo.flushPending();
      adapter.updateWithRevCheck = realUpdate;
      await repo.flushPending();

      expect(events).toHaveLength(1);
      expect(events[0].copy.title).toMatch(/^Second keystroke \(conflict copy — /);
      expect(adapter.rows.get('song-1').rev).toBe(2);
      expect(adapter.rows.size).toBe(2);
    });

    it('reports current: null and drops the cached row when the song is gone from the server', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'My Local Edit' }));
      adapter.rows.delete('song-1');
      await repo.flushPending();

      expect(events[0].current).toBeNull();
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      expect(cached.map((r) => r.id)).toEqual([events[0].copy.id]);
    });

    it('rolls the cached rev back when the winner cannot be fetched, so the next refresh adopts it', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'My Local Edit' }));
      adapter.rows.set('song-1', { ...adapter.rows.get('song-1'), rev: 2 });
      adapter.getById = vi.fn().mockRejectedValue(new Error('network down'));
      await repo.flushPending();

      expect(events[0].current).toBeUndefined();
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1')).find((r) => r.id === 'song-1');
      expect(cached.rev).toBe(1);
      const { changed } = await repo.refresh();
      expect(changed.map((s) => s.id)).toEqual(['song-1']);
    });

    it('an edit made right after create() waits for the insert instead of conflicting with it', async () => {
      const creating = repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Typed straight away' }));
      await creating;
      await repo.flushPending();
      expect(adapter.rows.size).toBe(1);
      expect(adapter.rows.get('song-1').rev).toBe(2);
    });
  });

  describe("refresh(): picking up other devices' changes in an open session", () => {
    it('returns new and newer songs, and ids tombstoned elsewhere', async () => {
      await repo.create(makeSong());
      await repo.create(makeSong({ id: 'song-2', title: 'Doomed' }));
      await repo.list();

      const other = new CloudSongsRepository({ adapter, userId: 'user-1', cacheKey: 'other', debounceMs: 50 });
      await other.list();
      await other.update('song-1', makeSong({ title: 'Edited on Android' }));
      await other.flushPending();
      await other.create(makeSong({ id: 'song-3', title: 'New on Android' }));
      await other.remove('song-2');
      other.dispose();

      const { changed, removed } = await repo.refresh();
      expect(changed.map((s) => s.title).sort()).toEqual(['Edited on Android', 'New on Android']);
      expect(removed).toEqual(['song-2']);
      // ...and the cache now has the server rows, so a second refresh is quiet.
      expect(await repo.refresh()).toEqual({ changed: [], removed: [] });
    });

    it('skips a song with an unsent edit, leaving its cached row alone', async () => {
      vi.useFakeTimers();
      await repo.create(makeSong());
      adapter.rows.set('song-1', { ...adapter.rows.get('song-1'), rev: 5 });
      await repo.update('song-1', makeSong({ title: 'Still typing' }));

      const { changed } = await repo.refresh();
      expect(changed).toEqual([]);
      const cached = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1')).find((r) => r.id === 'song-1');
      expect(cached.rev).toBe(2);
      expect((await repo.get('song-1')).title).toBe('Still typing');
    });
  });

  describe('bpm/capo', () => {
    it('writes them as numbers, 0 for unset, whatever the song held', async () => {
      await repo.create(makeSong({ bpm: '92', capo: '' }));
      const content = await decryptJSON(getDEK(), adapter.rows.get('song-1').content);
      expect(content.bpm).toBe(92);
      expect(content.capo).toBe(0);
    });

    it('reads strings from older rows as numbers', async () => {
      const content = await encryptJSON(getDEK(), {
        title: 'Old', lines: [], bpm: '120', key: 'G', tuning: '', capo: '',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      adapter.rows.set('old', { id: 'old', user_id: 'user-1', encrypted: true, content, rev: 1, deleted_at: null });
      const [listed] = await repo.list();
      expect(listed.bpm).toBe(120);
      expect(listed.capo).toBe(0);
    });
  });
});
