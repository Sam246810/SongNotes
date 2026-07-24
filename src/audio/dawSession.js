import { create } from 'zustand';

/**
 * In-memory-only (never persisted) per-song DAW audio for the current browser tab
 * session. Track objects hold live AudioBuffers by reference — fine to keep in memory,
 * but this must never be wired into any persist/serialize middleware.
 *
 * Lets DAWPanel remount per song (via a `key={song.id}`, resetting transient playback/
 * recording state) while keeping each song's recorded/imported tracks intact when you
 * switch away and back within the same session.
 */
const useDawSession = create((set, get) => ({
  tracksBySong: {}, // songId -> Track[]
  dirtyBySong: {}, // songId -> boolean (has unexported recorded/imported audio)

  getTracks: (songId) => (songId ? get().tracksBySong[songId] ?? null : null),

  saveTracks: (songId, tracks) => {
    if (!songId) return;
    set((s) => ({ tracksBySong: { ...s.tracksBySong, [songId]: tracks } }));
  },

  markDirty: (songId) => {
    if (!songId) return;
    set((s) => ({ dirtyBySong: { ...s.dirtyBySong, [songId]: true } }));
  },

  markExported: (songId) => {
    if (!songId) return;
    set((s) => ({ dirtyBySong: { ...s.dirtyBySong, [songId]: false } }));
  },

  clearSong: (songId) => set((s) => {
    const tracksBySong = { ...s.tracksBySong };
    delete tracksBySong[songId];
    const dirtyBySong = { ...s.dirtyBySong };
    delete dirtyBySong[songId];
    return { tracksBySong, dirtyBySong };
  }),
}));

export const selectAnyDawDirty = (s) => Object.values(s.dirtyBySong).some(Boolean);

export default useDawSession;
