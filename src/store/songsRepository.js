import { withAnchorChords } from '../utils/chordAnchors';
import { getDEK, getActiveDekId } from '../crypto/keyManager';
import { encryptJSON, decryptJSON } from '../crypto/envelope';
import { songToDocument, songFromDocument } from './songDocument';
import { mergeSongs } from '../sync/songMerge';
import { contentEquals } from '../sync/editStamps';

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
   * caller handles (see `CloudSongsRepository._resolveLostRace`, which merges),
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
 * Sync (docs/SYNC-MERGE.md, WIRE-FORMAT-v2.md section 5): every row carries a `rev`
 * and a `deleted_at` tombstone instead of a real delete. A push is
 * "`WHERE rev = <the rev this edit started from>`".
 *
 * A cached row is either *clean* -- exactly the server's row -- or *dirty*: it holds
 * an edit (or delete) the server hasn't confirmed, plus `base`, the server row that
 * edit started from (still ciphertext). While dirty, `rev` is `base.rev + 1`. When a
 * push loses the rev check, the song is merged three ways -- base, this device's
 * version, the server's newer version -- and the merged song is pushed instead. No
 * conflict copies: nothing either device wrote is dropped (see mergeSongs).
 */
export class CloudSongsRepository {
  constructor({ adapter, userId, cacheKey, debounceMs = 750 }) {
    this.adapter = adapter;
    this.userId = userId;
    this.cacheKey = cacheKey || `songnotes_cloud_cache:${userId}`;
    this.debounceMs = debounceMs;
    this._debounce = new Map(); // songId -> timer of the scheduled push
    // songId -> count of update/push/remove calls mid-await. refresh() leaves
    // these rows alone: their cache row is about to be (re)written by that call.
    this._busy = new Map();
    this._inserts = new Map(); // songId -> settled promise of its in-flight insert
    this._pushing = new Map(); // songId -> promise of the push running for it
    this._pushAgain = new Set(); // songIds edited while a push was running
    // Every edit the store hands over gets a per-song sequence number. `_head`
    // is the newest one; `_written` the one whose content is in the cache row;
    // `_merged` the last one a merge already folded in -- an encryption of an
    // older edit finishing late must not overwrite any of those.
    this._seq = new Map();
    this._head = new Map(); // songId -> { song, seq }
    this._written = new Map(); // songId -> seq
    this._merged = new Map(); // songId -> seq
    // Songs whose server row can't be merged with (encrypted under another key,
    // or unreadable). Left dirty, never pushed over, until the next hydrate.
    this._stuck = new Set();

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
    for (const timer of this._debounce.values()) clearTimeout(timer);
    this._debounce.clear();
  }

  /**
   * Listen for changes the repository makes to a song on its own, outside any
   * call the store made. Returns an unsubscribe function. Events:
   *   { type: 'merged', songId, song }  a push lost a race; `song` is the merge
   *                                     of both devices' edits, to show instead
   *   { type: 'restored', song }        a delete lost to an edit made elsewhere;
   *                                     the song is back
   *   { type: 'removed', songId }       the song is gone from the server
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

  _nextSeq(id) {
    const seq = (this._seq.get(id) ?? 0) + 1;
    this._seq.set(id, seq);
    return seq;
  }

  /** True while this song has an edit or delete the server hasn't confirmed. */
  hasUnsentChanges(id) {
    return this._debounce.has(id) || this._busy.has(id) || Boolean(this._cachedRow(id)?.base);
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

  _cachedRow(id) {
    return this._readCache().find((r) => r.id === id) ?? null;
  }

  _updateCacheRow(row) {
    const rows = this._readCache();
    const idx = rows.findIndex((r) => r.id === row.id);
    this._writeCache(idx === -1 ? [...rows, row] : rows.map((r, i) => (i === idx ? row : r)));
  }

  _removeCacheRow(id) {
    this._writeCache(this._readCache().filter((r) => r.id !== id));
  }

  /** What a dirty row records about the server row its edit started from. */
  _baseOf(serverRow) {
    if (!serverRow) return { rev: 0, content: null };
    return {
      rev: serverRow.rev,
      content: serverRow.content,
      encrypted: serverRow.encrypted,
      dek_id: serverRow.dek_id,
      deleted_at: serverRow.deleted_at ?? null,
    };
  }

  /** The row as sent to / stored by the server: no local-only fields. */
  _serverShape(row) {
    const { base: _base, ...rest } = row;
    return rest;
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

  /**
   * The cache reconciled with the server's rows. A clean cached row takes the
   * server's whenever that's newer (higher `rev` -- coordinated by the rev check,
   * so immune to clock skew). A dirty row is kept as is: the server moving on
   * underneath it is exactly what its push will merge.
   *
   * A cached row with a higher rev than the server's but no `base` was written by
   * an older version of this app (which bumped `rev` per keystroke and kept no
   * base): it becomes dirty here, with the base unknown, so its push merges
   * without one -- keeping everything both sides have, at worst a line twice.
   * (Guessing the server's row as the base would be tidier but could silently
   * drop another device's edit this one never saw.)
   */
  _reconcile(cachedRows, remoteRows) {
    const byId = new Map(cachedRows.map((r) => [r.id, r]));
    for (const r of remoteRows) {
      const cached = byId.get(r.id);
      if (!cached) {
        byId.set(r.id, r);
      } else if (cached.base) {
        // dirty: keep
      } else if (cached.rev > r.rev) {
        byId.set(r.id, { ...cached, rev: r.rev + 1, base: { rev: r.rev, content: null } });
      } else if (r.rev > cached.rev) {
        byId.set(r.id, r);
      }
    }
    return [...byId.values()];
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
    // Edits a previous session never got to send (closed tab, offline): send them now.
    this._stuck.clear();
    for (const row of rows) {
      if (row.base && !this._debounce.has(row.id) && !this._busy.has(row.id)) this._kick(row.id);
    }
    return songs;
  }

  /**
   * Pulls the server's rows into an already-loaded session (window focus, tab
   * shown, a periodic tick -- see useCloudSync) and reports only what another
   * device changed: `{ changed: Song[], removed: id[] }`, `changed` holding new
   * songs as well as newer versions of known ones. A song with an edit not yet
   * confirmed on the server is skipped entirely, cache row included: its push
   * merges whatever the server has. Idle songs with an unsent edit (a push that
   * failed or ran out of attempts) are retried from here.
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
      if (r.deleted_at || (cached && (cached.base || r.rev <= cached.rev))) continue;
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
    for (const row of byId.values()) {
      if (row.base && !this._debounce.has(row.id) && !this._busy.has(row.id)) this._kick(row.id);
    }
    return { changed, removed };
  }

  async get(id) {
    const row = this._cachedRow(id);
    return row ? this._songFromRow(row) : null;
  }

  async create(song) {
    await this._insert(song);
    return song;
  }

  /**
   * Inserts `song` as a new row at rev 1. Until that lands, update() of the same
   * id waits for it: otherwise an edit made right after creating a song finds no
   * cached row to start from.
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
    const seq = this._nextSeq(id);
    this._head.set(id, { song, seq });
    await this._inserts.get(id);
    const built = await this._buildRow(song, 0);
    // Superseded while encrypting: a newer edit is already in the cache, or a
    // merge already folded this one in (the store shows the merged song).
    if (seq <= (this._merged.get(id) ?? 0) || seq < (this._written.get(id) ?? 0)) return song;

    // Written to the cache at once so a reload never loses the latest edit even if
    // the debounced push hasn't fired yet. Re-read rather than reusing anything from
    // before the await: other rows (and this one's base) may have changed.
    const current = this._cachedRow(id);
    const base = current?.base ?? this._baseOf(current);
    this._updateCacheRow({ ...built, created_at: current?.created_at ?? built.created_at, rev: base.rev + 1, base });
    this._written.set(id, seq);
    this._schedulePush(id);
    return song;
  }

  async remove(id) {
    return this._whileBusy(id, () => this._remove(id));
  }

  async _remove(id) {
    this._cancelTimer(id);
    // Any edit still encrypting is for a song that's now deleted.
    this._merged.set(id, this._nextSeq(id));

    const current = this._cachedRow(id);
    if (!current || current.deleted_at) return; // nothing local to delete
    const base = current.base ?? this._baseOf(current);
    const now = new Date().toISOString();
    this._updateCacheRow({ ...current, deleted_at: now, updated_at: now, rev: base.rev + 1, base });
    await this._push(id);
  }

  _cancelTimer(id) {
    const timer = this._debounce.get(id);
    if (timer) clearTimeout(timer);
    this._debounce.delete(id);
  }

  _schedulePush(id) {
    this._cancelTimer(id);
    const timer = setTimeout(() => {
      this._debounce.delete(id);
      this._push(id).catch((e) => console.error('SongNotes: cloud sync failed for song', id, e));
    }, this.debounceMs);
    this._debounce.set(id, timer);
  }

  _kick(id) {
    this._push(id).catch((e) => console.error('SongNotes: cloud sync failed for song', id, e));
  }

  /** Sends the song's dirty row, if any. One push per song at a time. */
  _push(id) {
    const running = this._pushing.get(id);
    if (running) {
      this._pushAgain.add(id);
      return running;
    }
    const pushing = this._whileBusy(id, () => this._pushLoop(id)).finally(() => {
      this._pushing.delete(id);
      if (this._pushAgain.delete(id) && !this._debounce.has(id)) this._kick(id);
    });
    this._pushing.set(id, pushing);
    return pushing;
  }

  /** At most this many lost races in a row before leaving it for the next refresh. */
  static MAX_PUSH_ATTEMPTS = 3;

  async _pushLoop(id) {
    for (let attempt = 0; attempt < CloudSongsRepository.MAX_PUSH_ATTEMPTS; attempt++) {
      const row = this._cachedRow(id);
      if (!row?.base || this._stuck.has(id)) return;
      const pushedSeq = this._written.get(id) ?? 0;
      const send = this._serverShape(row);

      if (row.base.rev === 0) {
        // Never reached the server (its insert failed): insert it now.
        if (row.deleted_at) {
          this._removeCacheRow(id);
          return;
        }
        this._commitPushed(id, await this.adapter.insert({ ...send, rev: 1 }), row);
        return;
      }

      // A base that isn't known (an older app version's unsent edit) can't show
      // what the server changed since, so the push could never be trusted to win:
      // always merge with the server's version first.
      const baseUnknown = !row.base.content && !row.base.deleted_at;
      if (!baseUnknown) {
        const result = await this.adapter.updateWithRevCheck(id, send, row.base.rev);
        if (!result.conflict) {
          this._commitPushed(id, result.row, row);
          return;
        }
      }
      const done = await this._resolveLostRace(id, row, pushedSeq);
      if (done) return;
    }
  }

  /**
   * After a successful push: the cache row becomes the server's row -- unless an
   * edit was written on top while the push was out, which stays dirty against
   * the new server row and goes out next.
   */
  _commitPushed(id, serverRow, pushedRow) {
    const current = this._cachedRow(id);
    const unchanged = current
      && JSON.stringify(current.content) === JSON.stringify(pushedRow.content)
      && current.deleted_at === pushedRow.deleted_at;
    if (!current || unchanged) {
      this._updateCacheRow(serverRow);
      return;
    }
    this._updateCacheRow({ ...current, rev: serverRow.rev + 1, base: this._baseOf(serverRow) });
    this._schedulePush(id);
  }

  /**
   * A push lost the rev check: another device's write landed first. Fetches the
   * server's row and resolves, per docs/SYNC-MERGE.md:
   *
   *   this device      server        result
   *   edit             edited        merge both, push the merge
   *   edit             deleted       the edit wins: push the song back
   *   delete           unchanged     retry the delete
   *   delete           edited        the delete gives way: the song is restored
   *   delete           deleted       nothing to do
   *
   * Returns true when nothing more needs pushing.
   */
  async _resolveLostRace(id, row, pushedSeq) {
    const remote = await this.adapter.getById(id);
    if (remote === null) {
      // Gone from the server entirely (a key rotation's purge), not a race.
      this._cancelTimer(id);
      this._removeCacheRow(id);
      this._emit({ type: 'removed', songId: id });
      return true;
    }

    let remoteSong = null;
    let localSong = null;
    let baseSong = null;
    try {
      if (!remote.deleted_at) {
        if (this._isFromPreviousKey(remote)) throw new Error('server row is under a different key');
        remoteSong = await this._decryptRow(remote);
      }
      if (!row.deleted_at) localSong = await this._decryptRow(row);
    } catch (e) {
      // Never merge with, or push over, a row this device can't read.
      console.error('SongNotes: cannot merge song', id, 'with the server version', e);
      this._stuck.add(id);
      return true;
    }
    if (row.base.content && !row.base.deleted_at) {
      try {
        baseSong = await this._decryptRow({ ...row.base, id });
      } catch {
        baseSong = null; // merge without a base: keeps everything both sides have
      }
    }

    // Synchronous from here until the emit, so no edit can slip in between.
    if (row.deleted_at) {
      if (remote.deleted_at) {
        this._updateCacheRow(remote);
        return true;
      }
      if (baseSong && contentEquals(remoteSong, baseSong)) {
        // Only the rev moved: delete what this device saw.
        this._updateCacheRow({ ...row, rev: remote.rev + 1, base: this._baseOf(remote) });
        return false;
      }
      this._updateCacheRow(remote);
      this._emit({ type: 'restored', song: remoteSong });
      return true;
    }

    const merged = remote.deleted_at ? localSong : mergeSongs(baseSong, localSong, remoteSong);
    // Edits typed while the push was out were made on top of `localSong`; fold
    // them in the same way, so they survive too.
    const head = this._head.get(id);
    const final = head && head.seq > pushedSeq ? mergeSongs(localSong, head.song, merged) : merged;
    const mergeSeq = this._nextSeq(id);
    this._merged.set(id, mergeSeq);
    this._head.set(id, { song: final, seq: mergeSeq });
    this._cancelTimer(id);
    // The server row is the base for everything from here on, including edits the
    // store makes on top of the merged song while it's being encrypted.
    this._updateCacheRow({ ...row, rev: remote.rev + 1, base: this._baseOf(remote) });
    this._emit({ type: 'merged', songId: id, song: final });

    if (!remote.deleted_at && contentEquals(final, remoteSong)) {
      this._updateCacheRow(remote);
      this._written.set(id, mergeSeq);
      return true;
    }
    const built = await this._buildRow(final, remote.rev + 1);
    if ((this._written.get(id) ?? 0) < mergeSeq) {
      const current = this._cachedRow(id);
      this._updateCacheRow({ ...built, created_at: remote.created_at, base: current?.base ?? this._baseOf(remote) });
      this._written.set(id, mergeSeq);
    }
    return false;
  }

  /** Force any pending debounced writes out immediately (e.g. before logout/unload). */
  async flushPending() {
    const ids = [...this._debounce.keys()];
    await Promise.all(ids.map((id) => this._flushOne(id)));
  }

  async _flushOne(id) {
    if (!this._debounce.has(id)) return;
    this._cancelTimer(id);
    try {
      await this._push(id);
    } catch (e) {
      console.error('SongNotes: cloud sync failed for song', id, e);
    }
  }

  _flushAllPending() {
    for (const id of [...this._debounce.keys()]) {
      // Best-effort only — browsers don't reliably await work during unload.
      this._flushOne(id);
    }
  }

  /**
   * Drops every pending debounced write without pushing it — the opposite of
   * flushPending(). Needed before a DEK rotation/purge: a pending write's row was
   * built (encrypted) under the OLD DEK, so if its timer fired after the purge it
   * would push a "deleted" song back under a dead key. Call this before
   * purgeAll(), not after.
   */
  cancelPending() {
    for (const timer of this._debounce.values()) clearTimeout(timer);
    this._debounce.clear();
  }

  /**
   * Hard-deletes every song row this user has on the server (tombstones included —
   * a real DELETE, not another tombstone write) and clears the local cache. Used
   * only when the account DEK is being rotated (recovery code lost): the old rows
   * are cryptographically dead weight, not data to preserve, so this is
   * deliberately NOT the tombstone-based remove() above. Caller is responsible for
   * cancelPending() first and for calling this BEFORE establishing the new DEK
   * (see accountRecovery.js's rotateAndPurge).
   */
  async purgeAll() {
    await this.adapter.deleteAll(this.userId);
    this._writeCache([]);
    this._stuck.clear();
  }
}

export function createSongsRepository(mode = 'local', opts = {}) {
  if (mode === 'local') return new LocalSongsRepository();
  if (mode === 'cloud') return new CloudSongsRepository(opts);
  throw new Error(`Unknown songs repository mode: ${mode}`);
}
