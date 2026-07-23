import { alignChordsWithLyrics } from '../utils/chords';
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

  async update(id, row) {
    const { data, error } = await this.client.from('songs').update(row).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }

  async remove(id) {
    const { error } = await this.client.from('songs').delete().eq('id', id);
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
 * { list, insert, update, remove }.
 */
export class CloudSongsRepository {
  constructor({ adapter, userId, cacheKey, debounceMs = 750 }) {
    this.adapter = adapter;
    this.userId = userId;
    this.cacheKey = cacheKey || `songnotes_cloud_cache:${userId}`;
    this.debounceMs = debounceMs;
    this._debounce = new Map(); // songId -> { timer, row }
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

  /**
   * Union cached + remote rows, keeping whichever copy of each id is strictly newer.
   * On a tie, the cache wins: a local edit not yet pushed (debounced) shares its
   * source song's updatedAt with what's already on the server, and must not be
   * clobbered by that stale remote copy just because the timestamps are equal.
   */
  _reconcile(cachedRows, remoteRows) {
    const byId = new Map(cachedRows.map((r) => [r.id, r]));
    for (const r of remoteRows) {
      const cached = byId.get(r.id);
      if (!cached || new Date(r.updated_at) > new Date(cached.updated_at)) {
        byId.set(r.id, r);
      }
    }
    return [...byId.values()];
  }

  /** Build the persisted row for a song. Always encrypted — throws if the DEK isn't available. */
  async _buildRow(song) {
    const dek = getDEK();
    if (!dek) throw new Error('Cannot save: your account encryption key is not unlocked in this session.');

    const content = await encryptJSON(dek, {
      title: song.title,
      lines: song.lines,
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
    });

    return {
      id: song.id,
      user_id: this.userId,
      encrypted: true,
      content,
      title: null,
      is_locked: false,
      created_at: song.createdAt,
      updated_at: song.updatedAt,
    };
  }

  async _decryptRow(row) {
    // Backward-compat read path only — nothing writes encrypted:false anymore.
    if (!row.encrypted) {
      return { ...row.content, id: row.id };
    }
    const dek = getDEK();
    if (!dek) throw new Error('locked: account DEK unavailable');
    const content = await decryptJSON(dek, row.content);
    return { id: row.id, ...content };
  }

  _placeholderSong(row) {
    return {
      id: row.id,
      title: '🔒 Encrypted (unlock account to view)',
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
    if (!row) return null;
    try {
      return await this._decryptRow(row);
    } catch {
      return this._placeholderSong(row);
    }
  }

  async create(song) {
    const row = await this._buildRow(song);
    const created = await this.adapter.insert(row);
    this._writeCache([...this._readCache(), created]);
    return song;
  }

  async update(id, song) {
    const row = await this._buildRow(song);

    // Cache is written immediately so a reload never loses the latest edit even if
    // the debounced remote push hasn't fired yet.
    const cachedRows = this._readCache();
    const existingRow = cachedRows.find((r) => r.id === id) ?? null;
    const nextRows = existingRow
      ? cachedRows.map((r) => (r.id === id ? row : r))
      : [...cachedRows, row];
    this._writeCache(nextRows);

    this._scheduleRemotePush(id, row);
    return song;
  }

  async remove(id) {
    const pending = this._debounce.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this._debounce.delete(id);
    }
    this._writeCache(this._readCache().filter((r) => r.id !== id));
    await this.adapter.remove(id);
  }

  _scheduleRemotePush(id, row) {
    const pending = this._debounce.get(id);
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      this._debounce.delete(id);
      this.adapter.update(id, row).catch((e) => console.error('SongNotes: cloud sync failed for song', id, e));
    }, this.debounceMs);
    this._debounce.set(id, { timer, row });
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
      await this.adapter.update(id, pending.row);
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
