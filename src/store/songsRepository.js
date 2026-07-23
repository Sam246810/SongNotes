import { alignChordsWithLyrics } from '../utils/chords';

const STORAGE_KEY = 'songnotes_songs';

/**
 * Async persistence contract the store depends on. The store never touches
 * localStorage or a remote backend directly — only a SongsRepository implementation.
 *
 *   init()          -> Promise<void>          bind any session/session key needed to operate
 *   list()           -> Promise<Song[]>
 *   get(id)          -> Promise<Song|null>
 *   create(song)      -> Promise<Song>
 *   update(id, song)  -> Promise<Song>
 *   remove(id)        -> Promise<void>
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

  async list() {
    return loadFromStorage();
  }

  async get(id) {
    return loadFromStorage().find((s) => s.id === id) ?? null;
  }

  async create(song) {
    const songs = loadFromStorage();
    songs.push(song);
    saveToStorage(songs);
    return song;
  }

  async update(id, song) {
    const songs = loadFromStorage();
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) songs.push(song);
    else songs[idx] = song;
    saveToStorage(songs);
    return song;
  }

  async remove(id) {
    const songs = loadFromStorage().filter((s) => s.id !== id);
    saveToStorage(songs);
  }
}

export function createSongsRepository(mode = 'local') {
  if (mode === 'local') return new LocalSongsRepository();
  throw new Error(`Unknown songs repository mode: ${mode}`);
}
