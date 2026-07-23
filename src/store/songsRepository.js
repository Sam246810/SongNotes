import { alignChordsWithLyrics } from '../utils/chords';
import { getDEK, getUnlockedSongKey, setUnlockedSongKey, clearUnlockedSongKey, establishDEK } from '../crypto/keyManager';
import { generateContentKey, encryptJSON, decryptJSON, wrapContentKey, unwrapContentKey } from '../crypto/envelope';
import { generateSalt, deriveKEK, serializeKdfParams, deserializeKdfParams } from '../crypto/kdf';
import { unlockWithRecoveryCode } from '../crypto/accountKeys';
import { SupabaseUserKeysAdapter } from '../lib/userKeysAdapter';

const STORAGE_KEY = 'songnotes_songs';

/**
 * Async persistence contract the store depends on. The store never touches
 * localStorage or a remote backend directly — only a SongsRepository implementation.
 *
 *   init()                     -> Promise<void>  bind any session/key needed to operate
 *   list()                     -> Promise<Song[]>
 *   get(id)                    -> Promise<Song|null>
 *   create(song, options?)      -> Promise<Song>  options: { encrypted?: boolean }
 *   update(id, song)            -> Promise<Song>
 *   remove(id)                  -> Promise<void>
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

/**
 * Guest-mode repository — the original pre-accounts localStorage behavior, verbatim,
 * behind the async interface. Stateless (always reads/writes localStorage directly) so
 * test isolation via localStorage.clear() keeps working exactly as before.
 */
export class LocalSongsRepository {
  async init() {}

  async _decryptSong(song) {
    if (!song.encrypted) return song;
    const { contentEnvelope, ck } = song.content;
    if (!ck.wrappedBySong) {
      throw new Error('corrupt content-key envelope');
    }
    const songKey = getUnlockedSongKey(song.id);
    if (!songKey) throw new Error('locked: song password not entered this session');
    const content = await decryptJSON(songKey, contentEnvelope);
    return { ...song, ...content, isLocked: true };
  }

  _placeholderSong(song) {
    return {
      id: song.id,
      title: '🔒 Password-protected song',
      lines: [],
      isLocked: true,
      isUndecryptedPlaceholder: true,
      createdAt: song.createdAt || song.created_at,
      updatedAt: song.updatedAt || song.updated_at,
    };
  }

  async _buildSong(song, existingSong) {
    const encrypted = existingSong ? existingSong.encrypted : false;
    if (!encrypted) return song;

    const existingCk = existingSong?.content?.ck;
    let contentKey;
    if (existingCk?.wrappedBySong) {
      const songKey = getUnlockedSongKey(song.id);
      if (!songKey) throw new Error('Cannot save: this song is password-locked. Unlock it to edit.');
      contentKey = songKey;
    } else {
      throw new Error('corrupt content-key envelope');
    }

    const contentEnvelope = await encryptJSON(contentKey, {
      title: song.title,
      lines: song.lines,
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
    });

    return {
      id: song.id,
      encrypted: true,
      content: { contentEnvelope, ck: existingCk },
      isLocked: true,
      is_locked: true,
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
    };
  }

  async list() {
    const rawSongs = loadFromStorage();
    const songs = [];
    let updated = false;

    let guestId = sessionStorage.getItem('__songnotes_guest_session_id');
    if (!guestId) {
      guestId = crypto.randomUUID();
      sessionStorage.setItem('__songnotes_guest_session_id', guestId);
    }

    for (const s of rawSongs) {
      if (!s.guestSessionId) {
        s.guestSessionId = guestId;
        updated = true;
      }
      if (s.guestSessionId === guestId) {
        if (s.encrypted) {
          try {
            const decrypted = await this._decryptSong(s);
            songs.push(decrypted);
          } catch (e) {
            songs.push(this._placeholderSong(s));
          }
        } else {
          songs.push(s);
        }
      }
    }
    if (updated) {
      saveToStorage(rawSongs);
    }
    return songs;
  }

  async get(id) {
    const guestId = sessionStorage.getItem('__songnotes_guest_session_id');
    const song = loadFromStorage().find((s) => s.id === id && s.guestSessionId === guestId) ?? null;
    if (!song) return null;
    try {
      return await this._decryptSong(song);
    } catch {
      return this._placeholderSong(song);
    }
  }

  async create(song, _options) {
    const songs = loadFromStorage();
    let guestId = sessionStorage.getItem('__songnotes_guest_session_id');
    if (!guestId) {
      guestId = crypto.randomUUID();
      sessionStorage.setItem('__songnotes_guest_session_id', guestId);
    }
    const songWithGuestId = { ...song, guestSessionId: guestId };
    songs.push(songWithGuestId);
    saveToStorage(songs);
    return songWithGuestId;
  }

  async update(id, song) {
    const songs = loadFromStorage();
    const idx = songs.findIndex((s) => s.id === id);
    const existingSong = idx !== -1 ? songs[idx] : null;
    const finalSong = await this._buildSong(song, existingSong);

    let guestId = existingSong?.guestSessionId;
    if (!guestId) {
      guestId = sessionStorage.getItem('__songnotes_guest_session_id');
      if (!guestId) {
        guestId = crypto.randomUUID();
        sessionStorage.setItem('__songnotes_guest_session_id', guestId);
      }
    }
    finalSong.guestSessionId = guestId;

    if (idx === -1) songs.push(finalSong);
    else songs[idx] = finalSong;
    saveToStorage(songs);
    return finalSong;
  }

  async remove(id) {
    const guestId = sessionStorage.getItem('__songnotes_guest_session_id');
    const songs = loadFromStorage().filter((s) => s.id !== id || s.guestSessionId !== guestId);
    saveToStorage(songs);
  }

  async lockSong(id, password) {
    const songs = loadFromStorage();
    const song = songs.find((s) => s.id === id);
    if (!song) throw new Error('Song not found.');

    const plain = song.encrypted ? await this._decryptSong(song) : song;

    const newCk = await generateContentKey();
    const salt = generateSalt();
    const songKek = await deriveKEK(password, salt);
    const wrap = await wrapContentKey(songKek, newCk);
    const ck = { wrappedByDek: null, wrappedBySong: { kdf: serializeKdfParams(salt), wrap } };

    const contentEnvelope = await encryptJSON(newCk, {
      title: plain.title,
      lines: plain.lines,
      createdAt: plain.createdAt || plain.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const encryptedSong = {
      id,
      encrypted: true,
      content: { contentEnvelope, ck },
      isLocked: true,
      is_locked: true,
      createdAt: plain.createdAt || plain.created_at || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveToStorage(songs.map((s) => (s.id === id ? encryptedSong : s)));
    clearUnlockedSongKey(id); // immediately lock the song
    return this._placeholderSong(encryptedSong);
  }

  async unlockSongWithPassword(id, password) {
    const songs = loadFromStorage();
    const song = songs.find((s) => s.id === id);
    if (!song || !song.encrypted || !song.content.ck.wrappedBySong) {
      throw new Error('This song is not password-locked.');
    }
    const { kdf, wrap } = song.content.ck.wrappedBySong;
    const { salt } = deserializeKdfParams(kdf);
    const songKek = await deriveKEK(password, salt, kdf);
    const ck = await unwrapContentKey(songKek, wrap); // throws if wrong password
    setUnlockedSongKey(id, ck);
    return this._decryptSong(song);
  }

  relockSong(id) {
    clearUnlockedSongKey(id);
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
 * Account-mode repository: encrypts on write / decrypts on read (only for songs the
 * user chose to encrypt — see `encrypted` per song), against any adapter exposing
 * { list, insert, update, remove }, composing a local cache of the exact server row
 * shape (i.e. ciphertext, never plaintext) for instant loads and offline resilience.
 *
 * Encryption model: each encrypted song has its own random Content Key (CK), which
 * encrypts the song content. The CK itself is wrapped either by the account DEK
 * (normal encrypted song) or by a per-song-password-derived key (a locked song — see
 * src/crypto/keyManager's per-song key cache). Routine content edits reuse the
 * existing CK and its existing wrap — only the content ciphertext changes; the CK
 * (and how it's wrapped) is only touched by an explicit encrypt/lock/unlock action.
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

  /** Build (or refresh) the persisted row for a song, given whether it's encrypted. */
  async _buildRow(song, { encrypted, existingRow }) {
    if (!encrypted) {
      return {
        id: song.id,
        user_id: this.userId,
        encrypted: false,
        content: song,
        title: song.title,
        is_locked: false,
        created_at: song.createdAt,
        updated_at: song.updatedAt,
      };
    }

    let contentKey;
    let ck;
    const existingCk = existingRow?.encrypted ? existingRow.content.ck : null;

    if (existingCk?.wrappedByDek) {
      const dek = getDEK();
      if (!dek) throw new Error('Cannot save: account is locked. Unlock it to edit this encrypted song.');
      contentKey = await unwrapContentKey(dek, existingCk.wrappedByDek);
      ck = existingCk;
    } else if (existingCk?.wrappedBySong) {
      const songKey = getUnlockedSongKey(song.id);
      if (!songKey) throw new Error('Cannot save: this song is password-locked. Unlock it to edit.');
      contentKey = songKey;
      ck = existingCk;
    } else {
      // First time this song is being encrypted.
      const dek = getDEK();
      if (!dek) throw new Error('Cannot encrypt: set up an encryption passphrase first.');
      contentKey = await generateContentKey();
      ck = { wrappedByDek: await wrapContentKey(dek, contentKey), wrappedBySong: null };
    }

    const contentEnvelope = await encryptJSON(contentKey, {
      title: song.title,
      lines: song.lines,
      createdAt: song.createdAt,
      updatedAt: song.updatedAt,
    });

    return {
      id: song.id,
      user_id: this.userId,
      encrypted: true,
      content: { contentEnvelope, ck },
      title: null,
      is_locked: Boolean(ck.wrappedBySong),
      created_at: song.createdAt,
      updated_at: song.updatedAt,
    };
  }

  async _decryptRow(row) {
    if (!row.encrypted) {
      return { ...row.content, id: row.id };
    }
    const { contentEnvelope, ck } = row.content;
    let contentKey;
    if (row.is_locked) {
      const songKey = getUnlockedSongKey(row.id);
      if (!songKey) throw new Error('locked: song password not entered this session');
      contentKey = songKey;
    } else if (ck.wrappedByDek) {
      const dek = getDEK();
      if (!dek) throw new Error('locked: account DEK unavailable');
      contentKey = await unwrapContentKey(dek, ck.wrappedByDek);
    } else {
      throw new Error('corrupt content-key envelope');
    }
    const content = await decryptJSON(contentKey, contentEnvelope);
    return { id: row.id, ...content, isLocked: row.is_locked };
  }

  _placeholderSong(row) {
    return {
      id: row.id,
      title: row.is_locked ? '🔒 Password-protected song' : '🔒 Encrypted (unlock account to view)',
      lines: [],
      isLocked: true,
      isUndecryptedPlaceholder: true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Password-protect a song: re-encrypts its content under a brand-new content key
   * wrapped by a key derived from `password` (dropping any existing DEK-wrap), so
   * the account passphrase alone can no longer open it — only this song's password
   * can. The freshly unwrapped key is cached for this session so the user can keep
   * editing immediately after locking, without re-entering the password.
   */
  async lockSong(id, password) {
    const cachedRows = this._readCache();
    const existingRow = cachedRows.find((r) => r.id === id);
    if (!existingRow) throw new Error('Song not found.');

    const plain = existingRow.encrypted ? await this._decryptRow(existingRow) : existingRow.content;

    const newCk = await generateContentKey();
    const salt = generateSalt();
    const songKek = await deriveKEK(password, salt);
    const wrap = await wrapContentKey(songKek, newCk);
    const dek = getDEK();
    const wrappedByDek = dek ? await wrapContentKey(dek, newCk) : null;
    const ck = { wrappedByDek, wrappedBySong: { kdf: serializeKdfParams(salt), wrap } };

    const contentEnvelope = await encryptJSON(newCk, {
      title: plain.title,
      lines: plain.lines,
      createdAt: plain.createdAt,
      updatedAt: new Date().toISOString(),
    });

    const row = {
      id,
      user_id: this.userId,
      encrypted: true,
      content: { contentEnvelope, ck },
      title: null,
      is_locked: true,
      created_at: plain.createdAt,
      updated_at: new Date().toISOString(),
    };

    this._writeCache(cachedRows.map((r) => (r.id === id ? row : r)));
    await this.adapter.update(id, row); // explicit security action: push immediately, not debounced

    clearUnlockedSongKey(id);
    return this._placeholderSong(row);
  }

  /**
   * Verify a song's password, unwrap its content key, cache it for this session, and
   * return the now-decryptable song. Does not remove the lock — the song stays
   * password-protected for future sessions/devices.
   */
  async unlockSongWithPassword(id, password) {
    const row = this._readCache().find((r) => r.id === id);
    if (!row || !row.encrypted || !row.content.ck.wrappedBySong) {
      throw new Error('This song is not password-locked.');
    }
    const { kdf, wrap } = row.content.ck.wrappedBySong;
    const { salt } = deserializeKdfParams(kdf);
    const songKek = await deriveKEK(password, salt, kdf);
    const ck = await unwrapContentKey(songKek, wrap); // throws if the password is wrong

    setUnlockedSongKey(id, ck);
    return this._decryptRow(row);
  }

  async unlockSongWithRecoveryCode(id, recoveryCode) {
    const row = this._readCache().find((r) => r.id === id);
    if (!row || !row.encrypted || !row.content.ck.wrappedByDek) {
      throw new Error('This song cannot be unlocked with a recovery code.');
    }
    const keysAdapter = new SupabaseUserKeysAdapter(this.adapter.client, this.userId);
    const env = await keysAdapter.get();
    if (!env) throw new Error('No account recovery key found.');

    const dek = await unlockWithRecoveryCode(env, recoveryCode);
    establishDEK(dek);
    const ck = await unwrapContentKey(dek, row.content.ck.wrappedByDek);
    setUnlockedSongKey(id, ck);
    return this._decryptRow(row);
  }

  relockSong(id) {
    clearUnlockedSongKey(id);
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

  async create(song, { encrypted = false } = {}) {
    const row = await this._buildRow(song, { encrypted, existingRow: null });
    const created = await this.adapter.insert(row);
    this._writeCache([...this._readCache(), created]);
    return song;
  }

  async update(id, song) {
    const cachedRows = this._readCache();
    const existingRow = cachedRows.find((r) => r.id === id) ?? null;
    const encrypted = existingRow ? existingRow.encrypted : false;
    const row = await this._buildRow(song, { encrypted, existingRow });

    // Cache is written immediately so a reload never loses the latest edit even if
    // the debounced remote push hasn't fired yet.
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
