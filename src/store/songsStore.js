import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { alignChordsWithLyrics } from '../utils/chords';
import { transposeChordsLine } from '../utils/transpose';
import { LocalSongsRepository } from './songsRepository';
import useDawSession from '../audio/dawSession';

// -- Factory helpers --

export function createLine(chords = '', lyrics = '') {
  return { id: uuidv4(), chords: alignChordsWithLyrics(chords, lyrics), lyrics };
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
  // `lines`, when given, is a plain [{chords, lyrics}, ...] array (e.g. from
  // parsing an imported lyrics file) — each pair is run through createLine so
  // it gets a real id and the usual chords/lyrics length alignment. Omitted
  // or empty falls back to createSong's single default blank line.
  addSong: (title, { encrypted = false, lines } = {}) => {
    const song = createSong(title, { encrypted });
    if (lines && lines.length > 0) {
      song.lines = lines.map((l) => createLine(l.chords, l.lyrics));
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
  // same shape/merge pattern as updateLine.
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
  // batched update rather than one updateLine call per line.
  transposeSong: (id, semitones) => {
    if (!semitones) return;
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        const lines = s.lines.map((l) => {
          const chords = transposeChordsLine(l.chords, semitones);
          return { ...l, chords: alignChordsWithLyrics(chords, l.lyrics) };
        });
        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  setActiveSong: (id) => set({ activeSongId: id }),

  // --- Line-level actions ---
  updateLine: (songId, lineId, changes) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        const lines = s.lines.map((l) => {
          if (l.id === lineId) {
            const nextChords = changes.chords !== undefined ? changes.chords : l.chords;
            const nextLyrics = changes.lyrics !== undefined ? changes.lyrics : l.lyrics;
            const alignedChords = alignChordsWithLyrics(nextChords, nextLyrics);
            return { ...l, chords: alignedChords, lyrics: nextLyrics };
          }
          return l;
        });
        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(songId, updatedSong).catch(logPersistError);
  },


  addLineAfter: (songId, afterLineId) => {
    const newLine = createLine();
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        const idx = s.lines.findIndex((l) => l.id === afterLineId);
        const lines = [...s.lines];
        lines.splice(idx + 1, 0, newLine);
        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(songId, updatedSong).catch(logPersistError);
    return newLine.id;
  },

  deleteLine: (songId, lineId) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        if (s.lines.length <= 1) return s; // keep at least one line
        const lines = s.lines.filter((l) => l.id !== lineId);
        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(songId, updatedSong).catch(logPersistError);
  },

  splitLine: (songId, lineId, splitIndex, track, caretIndex) => {
    let targetFocus = null;
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        const idx = s.lines.findIndex((l) => l.id === lineId);
        if (idx === -1) return s;

        const line = s.lines[idx];
        const line1Lyrics = line.lyrics.slice(0, splitIndex);
        const line2Lyrics = line.lyrics.slice(splitIndex);
        const line1Chords = line.chords.slice(0, splitIndex);
        const line2Chords = line.chords.slice(splitIndex);

        const line1 = {
          ...line,
          chords: alignChordsWithLyrics(line1Chords, line1Lyrics),
          lyrics: line1Lyrics,
        };

        const line2 = createLine(line2Chords, line2Lyrics);

        const lines = [...s.lines];
        lines[idx] = line1;
        lines.splice(idx + 1, 0, line2);

        targetFocus = {
          lineId: line2.id,
          track: track || 'lyrics',
          caretIndex: typeof caretIndex === 'number' ? caretIndex : 0,
        };

        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(songId, updatedSong).catch(logPersistError);
    return targetFocus;
  },

  mergeLineWithPrevious: (songId, lineId) => {
    let targetFocus = null;
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        const idx = s.lines.findIndex((l) => l.id === lineId);
        if (idx <= 0) return s; // can't merge first line

        const prevLine = s.lines[idx - 1];
        const currLine = s.lines[idx];

        const prevLyricsLength = prevLine.lyrics.length;

        // Merge: concatenate lyrics and chords
        const alignedPrevChords = alignChordsWithLyrics(prevLine.chords, prevLine.lyrics);
        const mergedChords = alignedPrevChords + currLine.chords;
        const mergedLyrics = prevLine.lyrics + currLine.lyrics;

        const updatedPrevLine = {
          ...prevLine,
          chords: alignChordsWithLyrics(mergedChords, mergedLyrics),
          lyrics: mergedLyrics,
        };

        const lines = s.lines.filter((l) => l.id !== lineId);
        const prevIdx = lines.findIndex((l) => l.id === prevLine.id);
        lines[prevIdx] = updatedPrevLine;

        targetFocus = {
          lineId: prevLine.id,
          track: 'lyrics',
          caretIndex: prevLyricsLength,
        };

        updatedSong = { ...s, lines, updatedAt: new Date().toISOString() };
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(songId, updatedSong).catch(logPersistError);
    return targetFocus;
  },


  // --- Selectors ---
  getActiveSong: () => {
    const { songs, activeSongId } = get();
    return songs.find((s) => s.id === activeSongId) ?? null;
  },
}));

export default useSongsStore;
