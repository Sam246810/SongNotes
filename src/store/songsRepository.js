import { alignChordsWithLyrics } from '../utils/chords';
import { chordsLineToAnchors, anchorsToChordsLine } from '../utils/chordAnchors';
import { getDEK } from '../crypto/keyManager';
import { encryptJSON, decryptJSON } from '../crypto/envelope';

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
    return songs.map((s) => ({
      ...s,
      lines: s.lines.map((l) => ({
        ...l,
        chords: alignChordsWithLyrics(l.chords, l.lyrics),
      })),
    }));
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
 * { list, insert, updateWithRevCheck }.
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
   * `lines[].chords` is converted from this app's own editing representation
   * (a chords string space-padded to align above its lyrics) to wire-format
   * v2's per-chord-anchor shape (`{i, c}`, see `docs/WIRE-FORMAT-v2.md`
   * section 4) before encrypting — the same model the Android app's editor
   * natively uses. Storing the padded string verbatim would mean a song
   * edited on one platform renders wrong on the other: column position in a
   * padded string only means anything relative to that exact rendering, not
   * as portable data.
   */
  async _buildRow(song, rev) {
    const dek = getDEK();
    if (!dek) throw new Error('Cannot save: your account encryption key is not unlocked in this session.');

    const content = await encryptJSON(dek, {
      title: song.title,
      lines: song.lines.map((l) => ({ id: l.id, lyrics: l.lyrics, chords: chordsLineToAnchors(l.chords) })),
      bpm: song.bpm,
      key: song.key,
      tuning: song.tuning,
      capo: song.capo,
      customChords: song.customChords,
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
    });

    return {
      id: song.id,
      user_id: this.userId,
      encrypted: true,
      content,
      is_locked: false,
      rev,
      deleted_at: null,
      created_at: song.createdAt,
      updated_at: song.updatedAt,
    };
  }

  /**
   * Converts `lines[].chords` back from wire-format anchors to this app's own
   * padded-string editing representation. Tolerates `chords` already being a
   * padded string (not an anchors array) -- real encrypted rows written before
   * this conversion existed still decrypt to that shape, and there's no
   * version marker inside `content` to gate on, so this checks the actual
   * runtime type instead. Never crashes on real pre-existing data.
   */
  _anchorLinesToPaddedLines(lines) {
    return lines.map((l) => ({
      id: l.id,
      lyrics: l.lyrics,
      chords: alignChordsWithLyrics(
        Array.isArray(l.chords) ? anchorsToChordsLine(l.lyrics.length, l.chords) : l.chords,
        l.lyrics,
      ),
    }));
  }

  async _decryptRow(row) {
    // Backward-compat read path only — nothing writes encrypted:false anymore.
    // These predate the anchor conversion entirely, so `lines[].chords` here
    // is ALREADY a padded string, not anchors — do not convert it again.
    if (!row.encrypted) {
      return { ...row.content, id: row.id };
    }
    const dek = getDEK();
    if (!dek) throw new Error('locked: account DEK unavailable');
    const content = await decryptJSON(dek, row.content);
    return { id: row.id, ...content, lines: this._anchorLinesToPaddedLines(content.lines) };
  }

  _placeholderSong(row) {
    return {
      id: row.id,
      title: '🔒 Locked — click to unlock',
      lines: [],
      isUndecryptedPlaceholder: true,
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
      if (row.deleted_at) continue; // tombstoned -- kept in the cache for reconciliation, never shown
      try {
        songs.push(await this._decryptRow(row));
      } catch {
        songs.push(this._placeholderSong(row));
      }
    }
    return songs;
  }

  async get(id) {
    const row = this._readCache().find((r) => r.id === id);
    if (!row || row.deleted_at) return null;
    try {
      return await this._decryptRow(row);
    } catch {
      return this._placeholderSong(row);
    }
  }

  async create(song) {
    const row = await this._buildRow(song, 1);
    const created = await this.adapter.insert(row);
    this._writeCache([...this._readCache(), created]);
    return song;
  }

  async update(id, song) {
    const cachedRows = this._readCache();
    const existingRow = cachedRows.find((r) => r.id === id) ?? null;
    const nextRev = (existingRow?.rev ?? 0) + 1;
    const row = await this._buildRow(song, nextRev);

    // Cache is written immediately so a reload never loses the latest edit even if
    // the debounced remote push hasn't fired yet.
    this._writeCache(existingRow ? cachedRows.map((r) => (r.id === id ? row : r)) : [...cachedRows, row]);

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

  async _pushOne(id, song, row, expectedRev) {
    const result = await this.adapter.updateWithRevCheck(id, row, expectedRev);
    if (result.conflict) {
      await this._writeConflictCopy(song);
      return;
    }
    this._updateCacheRow(result.row);
  }

  /**
   * A lost optimistic-concurrency race means someone else's write already landed
   * with the rev this device expected. Rather than silently discarding this
   * device's edit (the exact "two devices editing different verses means one
   * silently vanishes" bug this whole rev/tombstone scheme exists to fix), it's
   * written as a brand new song, title marked so it's immediately obvious what
   * happened and where it came from.
   */
  async _writeConflictCopy(song) {
    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const conflictSong = {
      ...song,
      id: crypto.randomUUID(),
      title: `${song.title || 'Untitled'} (conflict copy — ${getDeviceLabel()}, ${timeLabel})`,
    };
    const row = await this._buildRow(conflictSong, 1);
    const created = await this.adapter.insert(row);
    this._writeCache([...this._readCache(), created]);
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
}

export function createSongsRepository(mode = 'local', opts = {}) {
  if (mode === 'local') return new LocalSongsRepository();
  if (mode === 'cloud') return new CloudSongsRepository(opts);
  throw new Error(`Unknown songs repository mode: ${mode}`);
}
