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

  describe('sync: tombstones and merging a lost race (docs/SYNC-MERGE.md)', () => {
    // A song with two lines, so two devices can edit different parts of it.
    const twoLines = (overrides = {}) => makeSong({
      lines: [
        { id: 'line-1', chords: [{ i: 0, c: 'Am' }], lyrics: 'first line' },
        { id: 'line-2', chords: [], lyrics: 'second line' },
      ],
      ...overrides,
    });
    const withLine = (song, id, lyrics) => ({ ...song, lines: song.lines.map((l) => (l.id === id ? { ...l, lyrics } : l)) });

    // "Another device": its own cache, same account DEK, same server.
    let other;
    beforeEach(() => {
      other = new CloudSongsRepository({ adapter, userId: 'user-1', cacheKey: 'other-device-cache', debounceMs: 50 });
    });
    afterEach(() => other.dispose());

    async function serverSong(id = 'song-1') {
      return decryptJSON(getDEK(), adapter.rows.get(id).content);
    }

    /** Both devices have the song; the other device then edits line 2 and pushes. */
    async function otherDeviceEditsFirst() {
      await repo.create(twoLines());
      await repo.list();
      await other.list();
      await other.update('song-1', withLine(twoLines(), 'line-2', 'second line, from the other device'));
      await other.flushPending();
    }

    it('a delete on another device propagates: list() hides the song once its remote row is tombstoned', async () => {
      await repo.create(makeSong());
      const remoteRow = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...remoteRow, deleted_at: new Date().toISOString(), rev: remoteRow.rev + 1 });

      const songs = await repo.list();
      expect(songs.find((s) => s.id === 'song-1')).toBeUndefined();
    });

    it('a lost race merges both edits into the one song: no conflict copy', async () => {
      await otherDeviceEditsFirst();
      await repo.update('song-1', withLine(twoLines(), 'line-1', 'first line, from this device'));
      await repo.flushPending();

      expect(adapter.rows.size).toBe(1);
      const merged = await serverSong();
      expect(merged.lines.map((l) => l.lyrics)).toEqual(['first line, from this device', 'second line, from the other device']);
      expect(adapter.rows.get('song-1').rev).toBe(3);
      expect(repo.hasUnsentChanges('song-1')).toBe(false);
    });

    it('tells listeners about the merged song so the store shows it', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await otherDeviceEditsFirst();
      await repo.update('song-1', withLine(twoLines(), 'line-1', 'first line, from this device'));
      await repo.flushPending();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('merged');
      expect(events[0].song.lines.map((l) => l.lyrics)).toEqual(['first line, from this device', 'second line, from the other device']);
    });

    it('after a merge, the next edits land on top of it without merging again', async () => {
      await otherDeviceEditsFirst();
      await repo.update('song-1', withLine(twoLines(), 'line-1', 'mine'));
      await repo.flushPending();
      const fetchesAfterMerge = adapter.calls.getById;

      const merged = await repo.get('song-1');
      await repo.update('song-1', { ...merged, title: 'Renamed' });
      await repo.flushPending();

      expect(adapter.calls.getById).toBe(fetchesAfterMerge);
      expect((await serverSong()).title).toBe('Renamed');
      expect(adapter.rows.size).toBe(1);
    });

    it('keeps edits typed while the losing push was out', async () => {
      await otherDeviceEditsFirst();
      const pushed = withLine(twoLines(), 'line-1', 'typed before the push');
      await repo.update('song-1', pushed);

      // Hold this device's push at the server until the next edit has been made.
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const realUpdate = adapter.updateWithRevCheck.bind(adapter);
      let held = false;
      adapter.updateWithRevCheck = async (...args) => {
        if (!held) {
          held = true;
          await gate;
        }
        return realUpdate(...args);
      };
      const flushing = repo.flushPending();
      await repo.update('song-1', { ...pushed, lines: [...pushed.lines, { id: 'line-3', chords: [], lyrics: 'typed during the push' }] });
      release();
      await flushing;
      await repo.flushPending();

      expect((await serverSong()).lines.map((l) => l.lyrics)).toEqual([
        'typed before the push',
        'second line, from the other device',
        'typed during the push',
      ]);
    });

    it('an edit beats a delete made on another device: the song comes back', async () => {
      await repo.create(twoLines());
      await repo.list();
      await other.list();
      await other.remove('song-1');
      expect(adapter.rows.get('song-1').deleted_at).not.toBeNull();

      await repo.update('song-1', withLine(twoLines(), 'line-1', 'still editing this'));
      await repo.flushPending();

      expect(adapter.rows.get('song-1').deleted_at).toBeNull();
      expect((await serverSong()).lines[0].lyrics).toBe('still editing this');
    });

    it('a delete gives way to an edit made on another device: the song is restored', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await otherDeviceEditsFirst();

      await repo.remove('song-1');

      expect(adapter.rows.get('song-1').deleted_at).toBeNull();
      expect(events.map((e) => e.type)).toEqual(['restored']);
      expect(events[0].song.lines[1].lyrics).toBe('second line, from the other device');
      expect((await repo.list()).map((s) => s.id)).toEqual(['song-1']);
    });

    it('a delete still goes through when the other device changed nothing', async () => {
      await repo.create(twoLines());
      await repo.list();
      await other.list();
      // Same content saved again elsewhere: the rev moves, the song doesn't.
      await other.update('song-1', twoLines());
      await other.flushPending();

      await repo.remove('song-1');
      expect(adapter.rows.get('song-1').deleted_at).not.toBeNull();
    });

    it('a merge that comes out identical to the server is not pushed again', async () => {
      await repo.create(twoLines());
      await repo.list();
      await other.list();
      const sameEdit = withLine(twoLines(), 'line-1', 'the same fix on both');
      await other.update('song-1', sameEdit);
      await other.flushPending();
      const updatesBefore = adapter.calls.updateWithRevCheck;

      await repo.update('song-1', sameEdit);
      await repo.flushPending();

      expect(adapter.calls.updateWithRevCheck).toBe(updatesBefore + 1); // the losing push only
      expect(repo.hasUnsentChanges('song-1')).toBe(false);
    });

    it('drops the song when it is gone from the server entirely', async () => {
      const events = [];
      repo.subscribe((e) => events.push(e));
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Edit' }));
      adapter.rows.delete('song-1'); // e.g. a key rotation's purge
      await repo.flushPending();

      expect(events).toEqual([{ type: 'removed', songId: 'song-1' }]);
      expect(await repo.get('song-1')).toBe(null);
      expect(adapter.rows.size).toBe(0);
    });

    it('never merges with or overwrites a server row it cannot read', async () => {
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Edit' }));
      const unreadable = { ...adapter.rows.get('song-1'), rev: 2, content: await encryptJSON(await generateContentKey(), { title: 'x' }) };
      adapter.rows.set('song-1', unreadable);
      await repo.flushPending();

      expect(adapter.rows.get('song-1')).toBe(unreadable);
      expect(repo.hasUnsentChanges('song-1')).toBe(true);
    });

    it('an edit still unsent when the tab closed is sent on the next load', async () => {
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Typed, then the tab closed' }));
      repo.dispose(); // no flush: the debounced push never fired

      const reopened = new CloudSongsRepository({ adapter, userId: 'user-1', debounceMs: 50 });
      await reopened.list();
      await vi.waitFor(async () => expect((await serverSong()).title).toBe('Typed, then the tab closed'));
      reopened.dispose();
    });

    it('merges an unsent edit cached by an older app version instead of overwriting the server', async () => {
      await repo.create(twoLines());
      await repo.list();
      await other.list();
      await other.update('song-1', withLine(twoLines(), 'line-2', 'second line, from the other device'));
      await other.flushPending(); // server: rev 2

      // What the old cache held: this device's edit, rev bumped per keystroke, no base.
      const cache = JSON.parse(localStorage.getItem('songnotes_cloud_cache:user-1'));
      const oldStyle = await repo._buildRow({ ...withLine(twoLines(), 'line-1', 'old-version edit'), updatedAt: '2030-01-01T00:00:00.000Z' }, 9);
      localStorage.setItem('songnotes_cloud_cache:user-1', JSON.stringify(cache.map((r) => (r.id === 'song-1' ? oldStyle : r))));

      const reopened = new CloudSongsRepository({ adapter, userId: 'user-1', debounceMs: 50 });
      await reopened.list();
      // No base to tell who changed what, so nothing is dropped: each line both
      // sides changed is kept in both versions.
      await vi.waitFor(async () => {
        expect((await serverSong()).lines.map((l) => l.lyrics).sort()).toEqual(
          ['first line', 'old-version edit', 'second line', 'second line, from the other device'],
        );
      });
      reopened.dispose();
    });

    it('stops after a few lost races in a row and leaves the edit for the next refresh', async () => {
      await repo.create(makeSong());
      await repo.update('song-1', makeSong({ title: 'Mine' }));
      // A server that some other writer has moved on, and keeps moving every time we look.
      const first = adapter.rows.get('song-1');
      adapter.rows.set('song-1', { ...first, rev: first.rev + 1 });
      const realGet = adapter.getById.bind(adapter);
      adapter.getById = async (id) => {
        const row = await realGet(id);
        adapter.rows.set(id, { ...row, rev: row.rev + 1 });
        return row;
      };
      await repo.flushPending();

      expect(adapter.calls.updateWithRevCheck).toBe(CloudSongsRepository.MAX_PUSH_ATTEMPTS);
      expect(repo.hasUnsentChanges('song-1')).toBe(true);

      adapter.getById = realGet; // the other writer stops
      await repo.refresh();
      await vi.waitFor(() => expect(repo.hasUnsentChanges('song-1')).toBe(false));
      expect((await serverSong()).title).toBe('Mine');
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
