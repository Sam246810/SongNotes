import { describe, it, expect, beforeEach, vi } from 'vitest';
import useSongsStore from '../store/songsStore';
import { LocalSongsRepository } from '../store/songsRepository';

describe('songsStore actions', () => {
  beforeEach(() => {
    localStorage.clear();
    useSongsStore.setState({
      songs: [],
      activeSongId: null,
      status: 'idle',
      error: null,
      repo: new LocalSongsRepository(),
    });
  });

  it('splits a line into two', () => {
    const songId = useSongsStore.getState().addSong('Test Song');
    const songBefore = useSongsStore.getState().songs.find(s => s.id === songId);
    const lineId = songBefore.lines[0].id;

    // Set initial text
    useSongsStore.getState().updateLine(songId, lineId, {
      chords: 'Am  C  G',
      lyrics: 'The quick brown fox',
    });

    // Split at index 10 ("brown")
    const targetFocus = useSongsStore.getState().splitLine(songId, lineId, 10, 'lyrics');
    const songAfter = useSongsStore.getState().songs.find(s => s.id === songId);

    expect(songAfter.lines).toHaveLength(2);
    expect(songAfter.lines[0].lyrics).toBe('The quick ');
    expect(songAfter.lines[1].lyrics).toBe('brown fox');

    // Chords are aligned/split
    expect(songAfter.lines[0].chords).toBe('Am  C  G  ');
    expect(songAfter.lines[1].chords).toBe('         ');

    expect(targetFocus).not.toBeNull();
    expect(targetFocus.lineId).toBe(songAfter.lines[1].id);
    expect(targetFocus.track).toBe('lyrics');
    expect(targetFocus.caretIndex).toBe(0);
  });

  it('merges a line with the previous one', () => {
    const songId = useSongsStore.getState().addSong('Test Song');
    const songBefore = useSongsStore.getState().songs.find(s => s.id === songId);
    const line1Id = songBefore.lines[0].id;

    // Add a second line
    const line2Id = useSongsStore.getState().addLineAfter(songId, line1Id);

    // Set initial texts
    useSongsStore.getState().updateLine(songId, line1Id, {
      chords: 'Am  ',
      lyrics: 'Hello ',
    });
    useSongsStore.getState().updateLine(songId, line2Id, {
      chords: 'G',
      lyrics: 'world',
    });

    // Merge line 2 with line 1
    const targetFocus = useSongsStore.getState().mergeLineWithPrevious(songId, line2Id);
    const songAfter = useSongsStore.getState().songs.find(s => s.id === songId);

    expect(songAfter.lines).toHaveLength(1);
    expect(songAfter.lines[0].lyrics).toBe('Hello world');
    // 'Am    ' + 'G    ' -> 'Am    G    '
    expect(songAfter.lines[0].chords).toBe('Am    G    '); // aligned to 'Hello world' (length 11)

    expect(targetFocus).not.toBeNull();
    expect(targetFocus.lineId).toBe(line1Id);
    expect(targetFocus.track).toBe('lyrics');
    expect(targetFocus.caretIndex).toBe(6); // index of merge boundary
  });

  it('persists a new song via the bound repository', async () => {
    const songId = useSongsStore.getState().addSong('Persisted Song');
    // repo.create is fire-and-forget; flush microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();
    const stored = JSON.parse(localStorage.getItem('songnotes_songs'));
    expect(stored.some((s) => s.id === songId && s.title === 'Persisted Song')).toBe(true);
  });
});

describe('songsStore hydration', () => {
  beforeEach(() => {
    localStorage.clear();
    useSongsStore.setState({
      songs: [],
      activeSongId: null,
      status: 'idle',
      error: null,
      repo: new LocalSongsRepository(),
    });
  });

  it('transitions idle -> hydrating -> ready and loads songs from the repo', async () => {
    const fakeSongs = [{ id: '1', title: 'Fake', lines: [], locked: false, createdAt: '', updatedAt: '' }];
    const fakeRepo = {
      init: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue(fakeSongs),
    };
    useSongsStore.setState({ repo: fakeRepo });

    const hydratePromise = useSongsStore.getState().hydrate();
    expect(useSongsStore.getState().status).toBe('hydrating');

    await hydratePromise;

    expect(fakeRepo.init).toHaveBeenCalled();
    expect(fakeRepo.list).toHaveBeenCalled();
    expect(useSongsStore.getState().status).toBe('ready');
    expect(useSongsStore.getState().songs).toEqual(fakeSongs);
  });

  it('transitions to error status when the repo fails to load', async () => {
    const fakeRepo = {
      init: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockRejectedValue(new Error('network down')),
    };
    useSongsStore.setState({ repo: fakeRepo });

    await useSongsStore.getState().hydrate();

    expect(useSongsStore.getState().status).toBe('error');
    expect(useSongsStore.getState().error).toBeInstanceOf(Error);
  });
});
