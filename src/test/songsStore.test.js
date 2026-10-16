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

  it('replaceLines splices lines in place and persists the result', async () => {
    const songId = useSongsStore.getState().addSong('Test Song');
    const [first] = useSongsStore.getState().songs.find((s) => s.id === songId).lines;

    // One line becoming two, as Enter does: the first keeps its id.
    const before = { ...first, lyrics: 'The quick ', chords: [{ i: 4, c: 'Am' }] };
    const after = { id: 'new-line', lyrics: 'brown fox', chords: [{ i: 0, c: 'G' }] };
    useSongsStore.getState().replaceLines(songId, 0, 1, [before, after]);
    expect(useSongsStore.getState().songs.find((s) => s.id === songId).lines).toEqual([before, after]);

    // Two lines becoming one, as backspace at the start of a line does.
    const joined = { ...before, lyrics: 'The quick brown fox', chords: [{ i: 4, c: 'Am' }, { i: 10, c: 'G' }] };
    useSongsStore.getState().replaceLines(songId, 0, 2, [joined]);
    expect(useSongsStore.getState().songs.find((s) => s.id === songId).lines).toEqual([joined]);

    await Promise.resolve();
    await Promise.resolve();
    const stored = JSON.parse(localStorage.getItem('songnotes_songs')).find((s) => s.id === songId);
    expect(stored.lines).toEqual([joined]);
  });

  it('turns imported padded chord rows into chord anchors', () => {
    const songId = useSongsStore.getState().addSong('Imported', {
      lines: [{ chords: 'G          C', lyrics: 'Amazing grace, how sweet' }, { chords: '', lyrics: '' }],
    });
    const { lines } = useSongsStore.getState().songs.find((s) => s.id === songId);
    expect(lines.map(({ lyrics, chords }) => ({ lyrics, chords }))).toEqual([
      { lyrics: 'Amazing grace, how sweet', chords: [{ i: 0, c: 'G' }, { i: 11, c: 'C' }] },
      { lyrics: '', chords: [] },
    ]);
  });

  it('transposes each chord where it is, so a longer name never shifts the chords after it', () => {
    const songId = useSongsStore.getState().addSong('Transpose');
    const lineId = useSongsStore.getState().songs.find((s) => s.id === songId).lines[0].id;
    useSongsStore.getState().replaceLines(songId, 0, 1, [
      { id: lineId, lyrics: 'one two three', chords: [{ i: 0, c: 'F' }, { i: 2, c: 'C' }, { i: 8, c: 'Intro' }] },
    ]);
    useSongsStore.getState().transposeSong(songId, 1);
    expect(useSongsStore.getState().songs.find((s) => s.id === songId).lines[0].chords).toEqual([
      { i: 0, c: 'F#' }, { i: 2, c: 'C#' }, { i: 8, c: 'Intro' },
    ]);
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
    const fakeSongs = [{ id: '1', title: 'Fake', lines: [], isReadOnly: false, createdAt: '', updatedAt: '' }];
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

  it('loads guest songs saved with v1 padded chord strings as chord anchors', async () => {
    sessionStorage.setItem('__songnotes_guest_session_id', 'guest-1');
    localStorage.setItem('songnotes_songs', JSON.stringify([{
      id: 'old', title: 'Old', guestSessionId: 'guest-1',
      lines: [{ id: 'l1', chords: 'Am    G   ', lyrics: 'a lyric from before' }],
    }]));
    useSongsStore.setState({ repo: new LocalSongsRepository() });
    await useSongsStore.getState().hydrate();
    expect(useSongsStore.getState().songs[0].lines[0].chords).toEqual([{ i: 0, c: 'Am' }, { i: 6, c: 'G' }]);
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
