import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { chordsLineToAnchors } from '../utils/chordAnchors';
import { transposeChordsLine } from '../utils/transpose';
import { LocalSongsRepository } from './songsRepository';
import useDawSession from '../audio/dawSession';

// -- Factory helpers --

// A line is a paragraph of any length, in wire-format v2's shape: `chords`
// are `{ i, c }` anchors into `lyrics` (docs/WIRE-FORMAT-v2.md section 4).
// The editor wraps it to the screen; that wrapping is never stored.
export function createLine(lyrics = '', chords = []) {
  return { id: uuidv4(), lyrics, chords };
}

export function createSong(title = 'Untitled Song', { encrypted = false } = {}) {
  return {
    id: uuidv4(),
    title,
    lines: [createLine()],
    // isReadOnly: a plain UI toggle, no security implications.
    isReadOnly: false,
    encrypted,
    // Optional reference info shown on the lyric sheet — all blank until the
    // user fills them in; none of these affect playback or storage.
    bpm: '',
    key: '',
    tuning: '',
    capo: '',
    // User-entered fretboard voicings for this song, keyed by normalized chord
    // name — fills gaps in (or overrides) the built-in CHORD_DB. See
    // setCustomChord/removeCustomChord below.
    customChords: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function logPersistError(err) {
  console.error('SongNotes: failed to persist song data', err);
}

// -- Zustand Store --

const useSongsStore = create((set, get) => ({
  songs: [],
  activeSongId: null,

  // status: 'idle' | 'hydrating' | 'ready' | 'error' — starts idle, App triggers hydrate()
  status: 'idle',
  error: null,
  // Defaults to guest-mode local storage; swapped for a CloudSongsRepository after login.
  repo: new LocalSongsRepository(),

  setRepo: (repo) => set({ repo, status: 'idle', songs: [], activeSongId: null }),

  hydrate: async () => {
    if (get().status === 'hydrating') return;
    set({ status: 'hydrating', error: null });
    try {
      await get().repo.init();
      const songs = await get().repo.list();
      set({ songs, status: 'ready' });
    } catch (error) {
      set({ status: 'error', error });
    }
  },

  // --- Song-level actions ---
  // `lines`, when given, is a plain [{chords, lyrics}, ...] array with each
  // chords row as a padded string (e.g. from parsing an imported lyrics file)
  // — each pair becomes a real line with an id and chord anchors. Omitted or
  // empty falls back to createSong's single default blank line.
  addSong: (title, { encrypted = false, lines } = {}) => {
    const song = createSong(title, { encrypted });
    if (lines && lines.length > 0) {
      song.lines = lines.map((l) => createLine(l.lyrics, chordsLineToAnchors(l.chords)));
    }
    set((state) => ({ songs: [...state.songs, song], activeSongId: song.id }));
    get().repo.create(song, { encrypted }).catch(logPersistError);
    return song.id;
  },

  deleteSong: (id) => {
    set((state) => {
      const songs = state.songs.filter((s) => s.id !== id);
      const activeSongId =
        state.activeSongId === id
          ? songs.length > 0
            ? songs[songs.length - 1].id
            : null
          : state.activeSongId;
      return { songs, activeSongId };
    });
    get().repo.remove(id).catch(logPersistError);
    useDawSession.getState().clearSong(id); // drop this song's in-memory DAW audio too
  },

  renameSong: (id, title) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        updatedSong = { ...s, title, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  // Reference info only (bpm/key/tuning/capo) — `changes` is a partial patch,
  // merged over the song.
  updateSongMeta: (id, changes) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        updatedSong = { ...s, ...changes, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  // User-entered fretboard voicing for one chord name, scoped to this song —
  // fills a gap in CHORD_DB, or overrides a built-in voicing the user thinks
  // is wrong. `voicing` is a { frets, baseFret } object (see parseFretsInput).
  setCustomChord: (id, chordName, voicing) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        updatedSong = {
          ...s,
          customChords: { ...(s.customChords || {}), [chordName]: voicing },
          updatedAt: new Date().toISOString(),
        };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  // Removes a custom voicing, reverting to CHORD_DB's built-in one (if any).
  removeCustomChord: (id, chordName) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        const customChords = { ...(s.customChords || {}) };
        delete customChords[chordName];
        updatedSong = { ...s, customChords, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  // Rewrites every recognized chord in the song by `semitones` (+/-), in one
  // batched update. Done per anchor, so a chord name getting longer (F -> F#)
  // never shifts the chords after it.
  transposeSong: (id, semitones) => {
    if (!semitones) return;
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        const lines = s.lines.map((l) => ({
          ...l,
          chords: l.chords.map((a) => ({ ...a, c: transposeChordsLine(a.c, semitones) })),
        }));
        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  setActiveSong: (id) => set({ activeSongId: id }),

  // --- Line-level actions ---
  // Every edit to a song's lines, as one splice: replaces `deleteCount` lines
  // from `start` with `newLines`. The editor works out the paragraphs an edit
  // produces (typing, Enter, joining two lines, a multi-line paste) and hands
  // them over here, so the store never needs to know about wrapping.
  replaceLines: (songId, start, deleteCount, newLines) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        const lines = [...s.lines];
        lines.splice(start, deleteCount, ...newLines);
        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(songId, updatedSong).catch(logPersistError);
  },

  // --- Selectors ---
  getActiveSong: () => {
    const { songs, activeSongId } = get();
    return songs.find((s) => s.id === activeSongId) ?? null;
  },
}));

export default useSongsStore;
