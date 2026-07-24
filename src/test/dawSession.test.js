import { describe, it, expect, beforeEach } from 'vitest';
import useDawSession, { selectAnyDawDirty } from '../audio/dawSession';

function resetStore() {
  useDawSession.setState({ tracksBySong: {}, dirtyBySong: {} });
}

describe('dawSession', () => {
  beforeEach(() => {
    resetStore();
  });

  it('saveTracks/getTracks round-trips per song', () => {
    const tracksA = [{ id: 't1', audioBuffer: { fake: true } }];
    const tracksB = [{ id: 't2', audioBuffer: { fake: true } }];

    useDawSession.getState().saveTracks('song-a', tracksA);
    useDawSession.getState().saveTracks('song-b', tracksB);

    expect(useDawSession.getState().getTracks('song-a')).toBe(tracksA);
    expect(useDawSession.getState().getTracks('song-b')).toBe(tracksB);
  });

  it('getTracks returns null for a song that has never been saved', () => {
    expect(useDawSession.getState().getTracks('never-seen')).toBeNull();
  });

  it('getTracks/saveTracks/markDirty/markExported all no-op for a falsy songId', () => {
    expect(useDawSession.getState().getTracks(null)).toBeNull();
    expect(useDawSession.getState().getTracks(undefined)).toBeNull();

    useDawSession.getState().saveTracks(null, [{ id: 'x' }]);
    useDawSession.getState().saveTracks(undefined, [{ id: 'y' }]);
    useDawSession.getState().markDirty(null);
    useDawSession.getState().markExported(undefined);

    // Nothing was ever written under any key.
    expect(useDawSession.getState().tracksBySong).toEqual({});
    expect(useDawSession.getState().dirtyBySong).toEqual({});
  });

  it('markDirty sets the song dirty, markExported clears it', () => {
    useDawSession.getState().markDirty('song-a');
    expect(useDawSession.getState().dirtyBySong['song-a']).toBe(true);

    useDawSession.getState().markExported('song-a');
    expect(useDawSession.getState().dirtyBySong['song-a']).toBe(false);
  });

  it('selectAnyDawDirty is true if ANY song is dirty, false once all are clean', () => {
    expect(selectAnyDawDirty(useDawSession.getState())).toBe(false);

    useDawSession.getState().markDirty('song-a');
    expect(selectAnyDawDirty(useDawSession.getState())).toBe(true);

    useDawSession.getState().markDirty('song-b');
    useDawSession.getState().markExported('song-a');
    expect(selectAnyDawDirty(useDawSession.getState())).toBe(true); // song-b still dirty

    useDawSession.getState().markExported('song-b');
    expect(selectAnyDawDirty(useDawSession.getState())).toBe(false);
  });

  it('clearSong removes both the tracks and the dirty flag for that song only', () => {
    useDawSession.getState().saveTracks('song-a', [{ id: 't1' }]);
    useDawSession.getState().saveTracks('song-b', [{ id: 't2' }]);
    useDawSession.getState().markDirty('song-a');
    useDawSession.getState().markDirty('song-b');

    useDawSession.getState().clearSong('song-a');

    expect(useDawSession.getState().getTracks('song-a')).toBeNull();
    expect('song-a' in useDawSession.getState().dirtyBySong).toBe(false);

    // song-b is untouched.
    expect(useDawSession.getState().getTracks('song-b')).toEqual([{ id: 't2' }]);
    expect(useDawSession.getState().dirtyBySong['song-b']).toBe(true);
  });
});
