import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { alignChordsWithLyrics } from '../utils/chords';

const STORAGE_KEY = 'songnotes_songs';

// -- Storage helpers (swap these two functions to move to a real backend) --

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

// -- Factory helpers --

export function createLine(chords = '', lyrics = '') {
  return { id: uuidv4(), chords: alignChordsWithLyrics(chords, lyrics), lyrics };
}

export function createSong(title = 'Untitled Song') {
  return {
    id: uuidv4(),
    title,
    lines: [createLine()],
    locked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}


// -- Zustand Store --

const useSongsStore = create((set, get) => ({
  songs: loadFromStorage(),
  activeSongId: null,

  // --- Song-level actions ---
  addSong: (title) => {
    const song = createSong(title);
    set((state) => {
      const songs = [...state.songs, song];
      saveToStorage(songs);
      return { songs, activeSongId: song.id };
    });
    return song.id;
  },

  deleteSong: (id) => {
    set((state) => {
      const songs = state.songs.filter((s) => s.id !== id);
      saveToStorage(songs);
      const activeSongId =
        state.activeSongId === id
          ? songs.length > 0
            ? songs[songs.length - 1].id
            : null
          : state.activeSongId;
      return { songs, activeSongId };
    });
  },

  renameSong: (id, title) => {
    set((state) => {
      const songs = state.songs.map((s) =>
        s.id === id ? { ...s, title, updatedAt: new Date().toISOString() } : s
      );
      saveToStorage(songs);
      return { songs };
    });
  },

  setActiveSong: (id) => set({ activeSongId: id }),

  toggleLock: (id) => {
    set((state) => {
      const songs = state.songs.map((s) =>
        s.id === id ? { ...s, locked: !s.locked, updatedAt: new Date().toISOString() } : s
      );
      saveToStorage(songs);
      return { songs };
    });
  },

  // --- Line-level actions ---
  updateLine: (songId, lineId, changes) => {
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
        return { ...s, lines, updatedAt: new Date().toISOString() };
      });
      saveToStorage(songs);
      return { songs };
    });
  },


  addLineAfter: (songId, afterLineId) => {
    const newLine = createLine();
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        const idx = s.lines.findIndex((l) => l.id === afterLineId);
        const lines = [...s.lines];
        lines.splice(idx + 1, 0, newLine);
        return { ...s, lines, updatedAt: new Date().toISOString() };
      });
      saveToStorage(songs);
      return { songs };
    });
    return newLine.id;
  },

  deleteLine: (songId, lineId) => {
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== songId) return s;
        if (s.lines.length <= 1) return s; // keep at least one line
        const lines = s.lines.filter((l) => l.id !== lineId);
        return { ...s, lines, updatedAt: new Date().toISOString() };
      });
      saveToStorage(songs);
      return { songs };
    });
  },

  splitLine: (songId, lineId, splitIndex, track, caretIndex) => {
    let targetFocus = null;
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

        return { ...s, lines, updatedAt: new Date().toISOString() };
      });
      saveToStorage(songs);
      return { songs };
    });
    return targetFocus;
  },

  mergeLineWithPrevious: (songId, lineId) => {
    let targetFocus = null;
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

        return { ...s, lines, updatedAt: new Date().toISOString() };
      });
      saveToStorage(songs);
      return { songs };
    });
    return targetFocus;
  },


  // --- Selectors ---
  getActiveSong: () => {
    const { songs, activeSongId } = get();
    return songs.find((s) => s.id === activeSongId) ?? null;
  },
}));

export default useSongsStore;
