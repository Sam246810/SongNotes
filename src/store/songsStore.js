import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { chordsLineToAnchors } from '../utils/chordAnchors';
import { transposeChordsLine } from '../utils/transpose';
import { LocalSongsRepository } from './songsRepository';
import { toMetaNumber } from './songDocument';
import { stampEdits } from '../sync/editStamps';
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
    // bpm/capo are whole numbers, 0 meaning unset (wire-format v2 section 4).
    bpm: 0,
    key: '',
    tuning: '',
    capo: 0,
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

// The bound repo's change listener, if it has one (see setRepo).
let unsubscribeRepo = null;
let refreshInFlight = null;

// A song from the repo, keeping this session's UI-only toggle.
function withSessionState(song, previous) {
  return previous ? { ...song, isReadOnly: previous.isReadOnly } : song;
}

// Which song to show once `removedId` is gone -- the same choice deleteSong makes.
function activeAfterRemoving(songs, activeSongId, removedId) {
  if (activeSongId !== removedId) return activeSongId;
  return songs.length > 0 ? songs[songs.length - 1].id : null;
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

  setRepo: (repo) => {
    unsubscribeRepo?.();
    unsubscribeRepo = repo.subscribe?.((event) => {
      if (get().repo === repo) get().applySyncEvent(event);
    }) ?? null;
    set({ repo, status: 'idle', songs: [], activeSongId: null });
  },

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

  /**
   * Picks up what other devices changed since hydrate() (the repo decides what
   * counts, skipping any song with edits not yet on the server). A no-op for
   * repos without refresh() -- guest mode has no other devices -- and while
   * not hydrated. Concurrent calls share one run.
   */
  refresh: () => {
    const { repo, status } = get();
    if (status !== 'ready' || typeof repo.refresh !== 'function') return Promise.resolve();
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const { changed, removed } = await repo.refresh();
        if (get().repo !== repo || (changed.length === 0 && removed.length === 0)) return;
        set((state) => {
          const byId = new Map(state.songs.map((s) => [s.id, s]));
          for (const song of changed) byId.set(song.id, withSessionState(song, byId.get(song.id)));
          let { activeSongId } = state;
          for (const id of removed) {
            byId.delete(id);
            activeSongId = activeAfterRemoving([...byId.values()], activeSongId, id);
          }
          return { songs: [...byId.values()], activeSongId };
        });
        for (const id of removed) useDawSession.getState().clearSong(id);
      } catch (e) {
        console.error('SongNotes: refresh from the server failed', e);
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  },

  /**
   * A change the repo made to a song on its own while syncing
   * (CloudSongsRepository.subscribe, docs/SYNC-MERGE.md):
   *   merged    another device's edit and this one's, combined -- shown in
   *             place, so the next keystroke edits the merged song
   *   restored  this device deleted it, another device had edited it: it's back
   *   removed   gone from the server
   * Runs synchronously inside the repo's sync step.
   */
  applySyncEvent: (event) => {
    if (event.type === 'merged') {
      set((state) => ({
        songs: state.songs.map((s) => (s.id === event.songId ? withSessionState(event.song, s) : s)),
      }));
    } else if (event.type === 'restored') {
      set((state) => {
        const exists = state.songs.some((s) => s.id === event.song.id);
        return {
          songs: exists
            ? state.songs.map((s) => (s.id === event.song.id ? withSessionState(event.song, s) : s))
            : [...state.songs, event.song],
        };
      });
    } else if (event.type === 'removed') {
      set((state) => {
        const songs = state.songs.filter((s) => s.id !== event.songId);
        return { songs, activeSongId: activeAfterRemoving(songs, state.activeSongId, event.songId) };
      });
      useDawSession.getState().clearSong(event.songId);
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

  // Every edit to an existing song goes through here: `mutate` returns the
  // changed song, which gets a fresh updatedAt and a per-line / per-field edit
  // stamp on whatever actually changed (src/sync/editStamps.js -- what a sync
  // merge uses to tell which device's edit is newer), then is persisted.
  commitSong: (id, mutate) => {
    let updatedSong = null;
    set((state) => {
      const songs = state.songs.map((s) => {
        if (s.id !== id) return s;
        const now = Date.now();
        updatedSong = stampEdits(s, { ...mutate(s), updatedAt: new Date(now).toISOString() }, now);
        return updatedSong;
      });
      return { songs };
    });
    if (updatedSong) get().repo.update(id, updatedSong).catch(logPersistError);
  },

  renameSong: (id, title) => get().commitSong(id, (s) => ({ ...s, title })),

  // Reference info only (bpm/key/tuning/capo) — `changes` is a partial patch,
  // merged over the song. bpm/capo may arrive as typed or imported text and
  // are stored as whole numbers, 0 meaning unset.
  updateSongMeta: (id, changes) => {
    changes = { ...changes };
    if ('bpm' in changes) changes.bpm = toMetaNumber(changes.bpm);
    if ('capo' in changes) changes.capo = toMetaNumber(changes.capo);
    get().commitSong(id, (s) => ({ ...s, ...changes }));
  },

  // User-entered fretboard voicing for one chord name, scoped to this song —
  // fills a gap in CHORD_DB, or overrides a built-in voicing the user thinks
  // is wrong. `voicing` is a { frets, baseFret } object (see parseFretsInput).
  setCustomChord: (id, chordName, voicing) =>
    get().commitSong(id, (s) => ({ ...s, customChords: { ...(s.customChords || {}), [chordName]: voicing } })),

  // Removes a custom voicing, reverting to CHORD_DB's built-in one (if any).
  removeCustomChord: (id, chordName) =>
    get().commitSong(id, (s) => {
      const customChords = { ...(s.customChords || {}) };
      delete customChords[chordName];
      return { ...s, customChords };
    }),

  // Rewrites every recognized chord in the song by `semitones` (+/-), in one
  // batched update. Done per anchor, so a chord name getting longer (F -> F#)
  // never shifts the chords after it.
  transposeSong: (id, semitones) => {
    if (!semitones) return;
    get().commitSong(id, (s) => ({
      ...s,
      lines: s.lines.map((l) => ({
        ...l,
        chords: l.chords.map((a) => ({ ...a, c: transposeChordsLine(a.c, semitones) })),
      })),
    }));
  },

  setActiveSong: (id) => set({ activeSongId: id }),

  // --- Line-level actions ---
  // Every edit to a song's lines, as one splice: replaces `deleteCount` lines
  // from `start` with `newLines`. The editor works out the paragraphs an edit
  // produces (typing, Enter, joining two lines, a multi-line paste) and hands
  // them over here, so the store never needs to know about wrapping.
  replaceLines: (songId, start, deleteCount, newLines) =>
    get().commitSong(songId, (s) => {
      const lines = [...s.lines];
      lines.splice(start, deleteCount, ...newLines);
      return { ...s, lines };
    }),

  // --- Selectors ---
  getActiveSong: () => {
    const { songs, activeSongId } = get();
    return songs.find((s) => s.id === activeSongId) ?? null;
  },
}));

export default useSongsStore;
