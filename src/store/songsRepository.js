import { withAnchorChords } from '../utils/chordAnchors';
import { getDEK, getActiveDekId } from '../crypto/keyManager';
import { encryptJSON, decryptJSON } from '../crypto/envelope';
import { songToDocument, songFromDocument } from './songDocument';

const STORAGE_KEY = 'songnotes_songs';

/**
 * Async persistence contract the store depends on. The store never touches
 * localStorage or a remote backend directly — only a SongsRepository implementation.
 *
 *   init()          -> Promise<void>  bind any session/key needed to operate
 *   list()          -> Promise<Song[]>
 *   get(id)         -> Promise<Song|null>
 *   create(song)    -> Promise<Song>
 *   update(id, song) -> Promise<Song>
 *   remove(id)       -> Promise<void>
 */

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const songs = raw ? JSON.parse(raw) : [];
    return songs.map((s) => ({ ...s, lines: withAnchorChords(s.lines) }));
  } catch {
    return [];
  }
}

function saveToStorage(songs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(songs));
  } catch (e) {
    console.error('SongNotes: failed to save to localStorage', e);
  }
}

/**
 * Removes every account-scoped local artifact this module (and migrateLocal.js) writes:
 * the per-user cloud cache of server rows, and the per-user "already migrated" flags.
 *
 * Nothing used to delete these — the only references to `cacheKey` were the constructor,
 * a read, and a write — so an account's cached rows outlived both sign-out AND account
 * deletion, sitting in localStorage indefinitely. The cached rows are ciphertext and the
 * DEK is wiped alongside them, so this was never a plaintext leak; what it did leak was
 * metadata (song count, row ids, timestamps, dek_id), and it quietly undercut the
 * "delete my account and data" claim the Play Store / GDPR flows are evaluated against —
 * the server side of deletion was complete, the device side wasn't.
 *
 * Prefix-sweeps every user's entry rather than only the active one, matching the
 * defense-in-depth reasoning already applied to the DEK sweep in crypto/keyManager.js:
 * a crashed or force-closed session can leave an entry behind for an account that is no
 * longer the active one, and that's exactly the copy nobody would think to clear.
 *
 * Deliberately does NOT touch `songnotes_songs` (guest-mode songs). Those are plaintext
 * and device-owned rather than account-owned — a guest who happens to sign in to an
 * account has not asked for their local drafts to be destroyed.
 */
export function clearAccountLocalCaches() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('songnotes_cloud_cache:') || key.startsWith('songnotes_migrated:'))) {
        localStorage.removeItem(key);
      }
    }
  } catch (e) {
    console.error('SongNotes: failed to clear local account caches', e);
  }
}

function getOrCreateGuestId() {
  let guestId = sessionStorage.getItem('__songnotes_guest_session_id');
  if (!guestId) {
    guestId = crypto.randomUUID();
    sessionStorage.setItem('__songnotes_guest_session_id', guestId);
  }
  return guestId;
}

/**
 * A short, friendly label for "which device/browser wrote this" -- used only to
 * make a sync conflict copy's title immediately understandable (see
 * `_writeConflictCopy` below), never for anything security- or identity-relevant.
 */
function getDeviceLabel() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  return `${browser} on ${os}`;
}

/**
 * Guest-mode repository — plain localStorage CRUD, scoped to the current guest session
 * so different guest sessions/tabs don't see each other's local data. Guests have no
 * account and therefore no encryption key, so guest songs are never encrypted.
 */
export class LocalSongsRepository {
  async init() {}

  async list() {
    const rawSongs = loadFromStorage();
    const guestId = getOrCreateGuestId();
    const songs = [];
    let updated = false;

    for (const s of rawSongs) {
      if (!s.guestSessionId) {
        s.guestSessionId = guestId;
        updated = true;
      }
      if (s.guestSessionId === guestId) songs.push(s);
    }
    if (updated) saveToStorage(rawSongs);
    return songs;
  }

  async get(id) {
    const guestId = sessionStorage.getItem('__songnotes_guest_session_id');
    return loadFromStorage().find((s) => s.id === id && s.guestSessionId === guestId) ?? null;
  }

  async create(song) {
    const songs = loadFromStorage();
    const songWithGuestId = { ...song, guestSessionId: getOrCreateGuestId() };
    songs.push(songWithGuestId);
    saveToStorage(songs);
    return songWithGuestId;
  }

  async update(id, song) {
    const songs = loadFromStorage();
    const idx = songs.findIndex((s) => s.id === id);
    const guestId = songs[idx]?.guestSessionId || getOrCreateGuestId();
    const finalSong = { ...song, guestSessionId: guestId };
    if (idx === -1) songs.push(finalSong);
    else songs[idx] = finalSong;
    saveToStorage(songs);
    return finalSong;
  }

  async remove(id) {
    const guestId = sessionStorage.getItem('__songnotes_guest_session_id');
    saveToStorage(loadFromStorage().filter((s) => s.id !== id || s.guestSessionId !== guestId));
  }
}

/**
 * Thin wrapper around a Supabase `songs` table. Deliberately dumb — no encryption, no
 * caching, no retry logic — those live in CloudSongsRepository so they can be unit
 * tested against a FakeRemoteAdapter without a live Supabase project.
 */
export class SupabaseSongsAdapter {
  constructor(client, userId) {
    this.client = client;
    this.userId = userId;
  }

  async list() {
    const { data, error } = await this.client.from('songs').select('*').eq('user_id', this.userId);
    if (error) throw error;
    return data;
  }

  async insert(row) {
    const { data, error } = await this.client.from('songs').insert(row).select().single();
    if (error) throw error;
    return data;
  }

  /** The row with this id, or null if there's none (or RLS hides it). */
  async getById(id) {
    const { data, error } = await this.client.from('songs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  /**
   * Conditional update — only writes if the row's current `rev` still matches
   * `expectedRev` (optimistic concurrency: `WHERE id = ? AND rev = ?`). Returns
   * `{ conflict: true }` (no row matched -- someone else already wrote a newer
   * rev) rather than throwing, since a lost race is an expected outcome the
   * caller handles (see `CloudSongsRepository._pushOne`'s conflict-copy path),
   * not an error condition.
   */
  async updateWithRevCheck(id, row, expectedRev) {
    const { data, error } = await this.client
      .from('songs')
      .update(row)
      .eq('id', id)
      .eq('rev', expectedRev)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return { conflict: true };
    return { conflict: false, row: data };
  }

  /**
   * Hard-deletes every row for this user — a real DELETE, not a tombstone write.
   * One statement rather than a per-row loop; RLS's `"own songs" for all` policy
   * covers DELETE, so this is scoped to the caller's own rows regardless of the
   * explicit `.eq('user_id', ...)` filter, which is kept anyway as defense in depth.
   */
  async deleteAll(userId) {
    const { error } = await this.client.from('songs').delete().eq('user_id', userId);
    if (error) throw error;
  }
}

/**
 * Account-mode repository: every song is always encrypted directly with the account's
 * Data Encryption Key (DEK) — no per-song key, no choice. envelope.js's encryptJSON
 * generates a fresh random IV on every call, which is what makes it safe to reuse the
 * same DEK across every song and every edit (AES-GCM's security model is exactly "one
 * key, many messages, each with a unique nonce").
 *
 * Composes a local cache of the exact server row shape (i.e. ciphertext, never
 * plaintext) for instant loads and offline resilience, against any adapter exposing
 * { list, getById, insert, updateWithRevCheck }.
 *
 * Sync-v2 (Tier 0, docs/PLAN.md "Phase 7"): every row carries a `rev` (bumped on every
 * write) and a `deleted_at` tombstone instead of a real delete. `_reconcile` compares by
 * `rev`, not wall-clock `updated_at` -- immune to clock skew between devices, and the
 * same optimistic-concurrency check that guards `_pushOne` naturally makes `rev` a
 * reliable causal order. A lost race NEVER silently drops an edit: the loser is written
 * as a new, separate song with a "(conflict copy — <device>, <time>)" title suffix
 * baked into the plaintext before encryption (the `title` column is gone -- nothing
 * server-side can see it to stamp a marker there instead).
 */
export class CloudSongsRepository {
  constructor({ adapter, userId, cacheKey, debounceMs = 750 }) {
    this.adapter = adapter;
    this.userId = userId;
    this.cacheKey = cacheKey || `songnotes_cloud_cache:${userId}`;
    this.debounceMs = debounceMs;
    this._debounce = new Map(); // songId -> { timer, song, row, expectedRev }
    // songId -> count of update/push/remove calls mid-await. refresh() leaves
    // these rows alone: their cache row is about to be (re)written by that call.
    this._busy = new Map();
    // songId -> how many conflicts it has resolved; see _update.
    this._conflicts = new Map();
    this._inserts = new Map(); // songId -> settled promise of its in-flight insert

    this._listeners = new Set();
    this._flushAllPending = this._flushAllPending.bind(this);
  }

  async init() {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('beforeunload', this._flushAllPending);
    }
  }

  dispose() {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('beforeunload', this._flushAllPending);
    }
  }

  /**
   * Listen for changes the repository makes on its own, outside any call the
   * store made: currently only `{ type: 'conflict', songId, current, copy }`
   * (see _resolveConflict). Returns an unsubscribe function.
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(event) {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('SongNotes: sync listener failed', e);
      }
    }
  }

  async _whileBusy(id, fn) {
    this._busy.set(id, (this._busy.get(id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = this._busy.get(id) - 1;
      if (n > 0) this._busy.set(id, n);
      else this._busy.delete(id);
    }
  }

  /** True while this song has an edit that isn't confirmed on the server yet. */
  hasUnsentChanges(id) {
    return this._debounce.has(id) || this._busy.has(id);
  }

  _readCache() {
    try {
      const raw = localStorage.getItem(this.cacheKey);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _writeCache(rows) {
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify(rows));
    } catch (e) {
      console.error('SongNotes: failed to write cloud cache', e);
    }
  }

  _updateCacheRow(row) {
    const rows = this._readCache();
    const idx = rows.findIndex((r) => r.id === row.id);
    this._writeCache(idx === -1 ? [...rows, row] : rows.map((r, i) => (i === idx ? row : r)));
  }

  /**
   * Union cached + remote rows, keeping whichever copy of each id has the higher
   * `rev`. `rev` (not `updated_at`) is the ordering signal -- it's coordinated via
   * `updateWithRevCheck`'s optimistic-concurrency check, so it's immune to clock
   * skew between devices the way comparing wall-clock timestamps isn't. A tombstoned
   * remote row (`deleted_at` set) with a higher rev than the cached copy simply wins
   * like any other update -- no special-casing needed, a delete is just another
   * write. On a tie, the cache wins: a local edit not yet pushed (debounced) shares
   * its source song's rev with what's already on the server, and must not be
   * clobbered by that stale remote copy just because the revs are equal.
   */
  _reconcile(cachedRows, remoteRows) {
    const byId = new Map(cachedRows.map((r) => [r.id, r]));
    for (const r of remoteRows) {
      const cached = byId.get(r.id);
      if (!cached || r.rev > cached.rev) {
        byId.set(r.id, r);
      }
    }
    return [...byId.values()];
  }

  /**
   * Build the persisted row for a song at a given rev. Always encrypted —
   * throws if the DEK isn't available.
   *
   * `lines` are already wire-format v2 lines (`{id, lyrics, chords}` with
   * `chords` as `{i, c}` anchors, see `docs/WIRE-FORMAT-v2.md` section 4) —
   * the app holds them that way, the same as the Android app. A line is a
   * whole paragraph however long; wrapping it to a screen is display-only,
   * so nothing here (or on the way back) ever cuts or pads it into rows.
   */
  async _buildRow(song, rev) {
    const dek = getDEK();
    if (!dek) throw new Error('Cannot save: your account encryption key is not unlocked in this session.');

    const content = await encryptJSON(dek, songToDocument(song));

    return {
      id: song.id,
      user_id: this.userId,
      encrypted: true,
      content,
      is_locked: false,
      dek_id: getActiveDekId(),
      rev,
      deleted_at: null,
      created_at: song.createdAt,
      updated_at: song.updatedAt,
    };
  }

  async _decryptRow(row) {
    // Backward-compat read path only — nothing writes encrypted:false anymore.
    // These predate the anchor conversion entirely, so `lines[].chords` here
    // is still v1's padded string; songFromDocument reads that (and the other
    // legacy shapes encrypted rows can still hold) too.
    if (!row.encrypted) return songFromDocument(row.id, row.content);
    const dek = getDEK();
    if (!dek) throw new Error('locked: account DEK unavailable');
    return songFromDocument(row.id, await decryptJSON(dek, row.content));
  }

  /** The song a cached/remote row shows as: null if tombstoned, else decrypted or a placeholder. */
  async _songFromRow(row) {
    if (row.deleted_at) return null;
    if (this._isFromPreviousKey(row)) return this._placeholderSong(row, 'previous-key');
    try {
      return await this._decryptRow(row);
    } catch {
      return this._placeholderSong(row);
    }
  }

  /**
   * True iff this row's `dek_id` is known and differs from the currently
   * unlocked DEK's -- almost always the aftermath of a DEK rotation (recovery
   * code lost, see accountRecovery.js's rotateAndPurge; the purge itself hard-
   * deletes rows, but a row synced from another device between the rotation
   * and its own purge running there can slip through). `false` (not "unknown")
   * whenever either side is missing -- a row with no `dek_id` predates this
   * column and gets no special-casing, and with no active DEK at all this
   * can't be evaluated either way, so callers fall through to the generic
   * "locked, not decrypted yet" path instead of guessing.
   */
  _isFromPreviousKey(row) {
    const activeDekId = getActiveDekId();
    return Boolean(row.dek_id && activeDekId && row.dek_id !== activeDekId);
  }

  /**
   * @param {'undecryptable'|'previous-key'} reason 'previous-key' is known
   *   ahead of time from `_isFromPreviousKey` (skips a decrypt attempt that's
   *   guaranteed to fail); 'undecryptable' covers everything else a decrypt
   *   attempt can throw on (session simply not unlocked yet, genuine corruption).
   */
  _placeholderSong(row, reason = 'undecryptable') {
    const isFromPreviousKey = reason === 'previous-key';
    return {
      id: row.id,
      title: isFromPreviousKey ? '🔒 Encrypted under a previous key' : '🔒 Locked — click to unlock',
      lines: [],
      isUndecryptedPlaceholder: true,
      isFromPreviousKey,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list() {
    const cachedRows = this._readCache();
    let rows = cachedRows;
    try {
      const remoteRows = await this.adapter.list();
      rows = this._reconcile(cachedRows, remoteRows);
      this._writeCache(rows);
    } catch (e) {
      console.error('SongNotes: cloud sync unavailable, using local cache', e);
    }

    const songs = [];
    for (const row of rows) {
      // Tombstoned rows come back null -- kept in the cache for reconciliation, never shown.
      const song = await this._songFromRow(row);
      if (song) songs.push(song);
    }
    return songs;
  }

  /**
   * Pulls the server's rows into an already-loaded session (window focus, tab
   * shown, a periodic tick -- see useCloudSync) and reports only what another
   * device changed: `{ changed: Song[], removed: id[] }`, `changed` holding new
   * songs as well as newer versions of known ones. A song with an edit not yet
   * confirmed on the server is skipped entirely, cache row included: its own
   * push either lands on top or loses the race and goes through
   * _resolveConflict, so a refresh never replaces something the user typed.
   *
   * Everything after the last await runs synchronously, so the result matches
   * the cache at the moment it's returned; the store applies it in the next
   * microtask, before any input event can start another edit.
   */
  async refresh() {
    const remoteRows = await this.adapter.list();

    const snapshot = new Map(this._readCache().map((r) => [r.id, r]));
    const decrypted = new Map();
    for (const r of remoteRows) {
      const cached = snapshot.get(r.id);
      if (r.deleted_at || (cached && r.rev <= cached.rev)) continue;
      decrypted.set(r.id, await this._songFromRow(r));
    }

    const byId = new Map(this._readCache().map((r) => [r.id, r]));
    const changed = [];
    const removed = [];
    for (const r of remoteRows) {
      if (this.hasUnsentChanges(r.id)) continue;
      const cached = byId.get(r.id);
      if (cached && r.rev <= cached.rev) continue;
      if (r.deleted_at) {
        if (cached && !cached.deleted_at) removed.push(r.id);
      } else if (decrypted.has(r.id)) {
        changed.push(decrypted.get(r.id));
      } else {
        continue; // the cache moved under us mid-refresh; the next refresh picks this up
      }
      byId.set(r.id, r);
    }
    this._writeCache([...byId.values()]);
    return { changed, removed };
  }

  async get(id) {
    const row = this._readCache().find((r) => r.id === id);
    return row ? this._songFromRow(row) : null;
  }

  async create(song) {
    await this._insert(song);
    return song;
  }

  /**
   * Inserts `song` as a new row at rev 1. Until that lands, update() of the same
   * id waits for it: otherwise an edit made right after creating a song (or
   * opening a fresh conflict copy) finds no cached row, pushes expecting rev 0,
   * and loses to its own insert.
   */
  _insert(song) {
    const inserting = this._whileBusy(song.id, async () => {
      const row = await this._buildRow(song, 1);
      const created = await this.adapter.insert(row);
      this._updateCacheRow(created);
    });
    const settled = inserting.catch(() => {}).finally(() => {
      if (this._inserts.get(song.id) === settled) this._inserts.delete(song.id);
    });
    this._inserts.set(song.id, settled);
    return inserting;
  }

  async update(id, song) {
    return this._whileBusy(id, () => this._update(id, song));
  }

  async _update(id, song) {
    await this._inserts.get(id);
    const conflictsBefore = this._conflicts.get(id) ?? 0;
    const existingRow = this._readCache().find((r) => r.id === id) ?? null;
    const nextRev = (existingRow?.rev ?? 0) + 1;
    const row = await this._buildRow(song, nextRev);
    if ((this._conflicts.get(id) ?? 0) !== conflictsBefore) {
      // A conflict resolved while this was encrypting: `song` is an edit of the
      // version that lost, and the store now shows the winner. Pushing it would
      // overwrite the winner at a rev that may well match.
      console.error('SongNotes: dropped an edit of song', id, 'made just before a sync conflict resolved');
      return song;
    }

    // Cache is written immediately so a reload never loses the latest edit even if
    // the debounced remote push hasn't fired yet. Re-read rather than reusing the
    // copy from before the await: other rows may have changed during encryption.
    this._updateCacheRow(row);

    // expectedRev is the rev the SERVER should currently have. Captured once per
    // debounce burst (from the pending entry if one's already in flight, or from
    // the cache otherwise) -- re-reading it from our own cache on every keystroke
    // would read the rev we JUST optimistically bumped above, not the last
    // confirmed-remote rev, breaking the optimistic-concurrency check entirely.
    const pending = this._debounce.get(id);
    const expectedRev = pending ? pending.expectedRev : (existingRow?.rev ?? 0);
    this._scheduleRemotePush(id, song, row, expectedRev);
    return song;
  }

  async remove(id) {
    return this._whileBusy(id, () => this._remove(id));
  }

  async _remove(id) {
    const pending = this._debounce.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this._debounce.delete(id);
    }

    const cachedRows = this._readCache();
    const existingRow = cachedRows.find((r) => r.id === id);
    if (!existingRow) return; // nothing local to delete

    // Same "confirmed remote rev, not our own optimistically-bumped cache rev"
    // reasoning as update()'s expectedRev -- a pending (now-cancelled) edit may
    // have already bumped the cached rev past what the server actually has.
    const expectedRev = pending ? pending.expectedRev : existingRow.rev;

    const tombstoneRow = {
      ...existingRow,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      rev: existingRow.rev + 1,
    };
    this._writeCache(cachedRows.map((r) => (r.id === id ? tombstoneRow : r)));

    const result = await this.adapter.updateWithRevCheck(id, tombstoneRow, expectedRev);
    if (result.conflict) {
      // Someone else edited concurrently -- Tier 0's simplest reasonable choice is
      // to let that edit stand rather than force a delete through (full 3-way merge
      // of "delete vs. concurrent edit" is Tier 1 territory). Not silently wrong:
      // the next list() reconciles against the real current row either way.
      console.error('SongNotes: delete for song', id, 'conflicted with a concurrent edit');
    } else {
      this._updateCacheRow(result.row);
    }
  }

  _scheduleRemotePush(id, song, row, expectedRev) {
    const pending = this._debounce.get(id);
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this._debounce.delete(id);
      this._pushOne(id, song, row, expectedRev).catch((e) => console.error('SongNotes: cloud sync failed for song', id, e));
    }, this.debounceMs);
    this._debounce.set(id, { timer, song, row, expectedRev });
  }

  _pushOne(id, song, row, expectedRev) {
    return this._whileBusy(id, async () => {
      const result = await this.adapter.updateWithRevCheck(id, row, expectedRev);
      if (result.conflict) {
        await this._resolveConflict(id, song, expectedRev);
        return;
      }
      this._updateCacheRow(result.row);
    });
  }

  /**
   * A lost optimistic-concurrency race means someone else's write already landed
   * with the rev this device expected. Rather than silently discarding this
   * device's edit (the exact "two devices editing different verses means one
   * silently vanishes" bug this whole rev/tombstone scheme exists to fix), it's
   * written as a brand new song, title marked so it's immediately obvious what
   * happened and where it came from -- and the original id goes back to showing
   * the server's (winning) version.
   *
   * That second half matters as much as the copy: the cache still holds this
   * device's optimistic row, whose rev the next update() builds on, so leaving
   * it there made every later save of the song lose the same race again and
   * write yet another copy. The winning row replaces it here, and listeners
   * (the store) swap the song for it in the same synchronous step, so the next
   * keystroke is an edit of the winner at its real rev.
   */
  async _resolveConflict(id, song, expectedRev) {
    let current;
    let currentSong;
    try {
      current = await this.adapter.getById(id);
      currentSong = current ? await this._songFromRow(current) : null;
    } catch (e) {
      console.error('SongNotes: could not fetch the current version of conflicted song', id, e);
    }

    // Synchronous from here to the emit. Keystrokes made while the push was out
    // were stacked on this device's losing version; they belong in the copy, not
    // pushed over the winner.
    const pending = this._debounce.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this._debounce.delete(id);
    }
    const copy = this._conflictCopyOf(pending?.song ?? song);
    this._conflicts.set(id, (this._conflicts.get(id) ?? 0) + 1);

    if (current) {
      this._updateCacheRow(current);
    } else if (current === null) {
      this._writeCache(this._readCache().filter((r) => r.id !== id));
    } else {
      // The fetch failed: roll the cached row back to the last rev the server
      // confirmed, so the next list()/refresh() adopts whatever's there now.
      const cached = this._readCache().find((r) => r.id === id);
      if (cached) this._updateCacheRow({ ...cached, rev: expectedRev });
    }

    // `current`: the song as the server now has it; null if it's gone or
    // tombstoned; undefined if that couldn't be found out.
    this._emit({ type: 'conflict', songId: id, current: current === undefined ? undefined : currentSong, copy });

    await this._insert(copy);
  }

  _conflictCopyOf(song) {
    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return {
      ...song,
      id: crypto.randomUUID(),
      title: `${song.title || 'Untitled'} (conflict copy — ${getDeviceLabel()}, ${timeLabel})`,
    };
  }


  /** Force any pending debounced writes out immediately (e.g. before logout/unload). */
  async flushPending() {
    const ids = [...this._debounce.keys()];
    await Promise.all(ids.map((id) => this._flushOne(id)));
  }

  async _flushOne(id) {
    const pending = this._debounce.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._debounce.delete(id);
    try {
      await this._pushOne(id, pending.song, pending.row, pending.expectedRev);
    } catch (e) {
      console.error('SongNotes: cloud sync failed for song', id, e);
    }
  }

  _flushAllPending() {
    for (const id of this._debounce.keys()) {
      // Best-effort only — browsers don't reliably await work during unload.
      this._flushOne(id);
    }
  }

  /**
   * Drops every pending debounced write without pushing it — the opposite of
   * flushPending(). Needed before a DEK rotation/purge: a pending entry's `row`
   * was already built (encrypted) under the OLD DEK, so if its timer fired after
   * the purge it would write a fresh conflict copy under a dead key, resurrecting
   * a "deleted" song. Call this before purgeAll(), not after.
   */
  cancelPending() {
    for (const { timer } of this._debounce.values()) clearTimeout(timer);
    this._debounce.clear();
  }

  /**
   * Hard-deletes every song row this user has on the server (tombstones and
   * conflict copies included — a real DELETE, not another tombstone write) and
   * clears the local cache. Used only when the account DEK is being rotated
   * (recovery code lost): the old rows are cryptographically dead weight, not
   * data to preserve, so this is deliberately NOT the tombstone-based remove()
   * above. Caller is responsible for cancelPending() first and for calling this
   * BEFORE establishing the new DEK (see accountRecovery.js's rotateAndPurge).
   */
  async purgeAll() {
    await this.adapter.deleteAll(this.userId);
    this._writeCache([]);
  }
}

export function createSongsRepository(mode = 'local', opts = {}) {
  if (mode === 'local') return new LocalSongsRepository();
  if (mode === 'cloud') return new CloudSongsRepository(opts);
  throw new Error(`Unknown songs repository mode: ${mode}`);
}
