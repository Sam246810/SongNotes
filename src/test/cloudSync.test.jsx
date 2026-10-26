import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import useSongsStore from '../store/songsStore';
import { CloudSongsRepository, LocalSongsRepository } from '../store/songsRepository';
import { generateContentKey } from '../crypto/envelope';
import { establishDEK, clearSession } from '../crypto/keyManager';
import { startForegroundRefresh, REFRESH_INTERVAL_MS } from '../auth/useCloudSync';

/** In-memory stand-in for the Supabase `songs` table (same as songsRepository.test.js's). */
class FakeRemoteAdapter {
  constructor() {
    this.rows = new Map();
  }
  async list() {
    return [...this.rows.values()];
  }
  async getById(id) {
    return this.rows.get(id) ?? null;
  }
  async insert(row) {
    this.rows.set(row.id, row);
    return row;
  }
  async updateWithRevCheck(id, row, expectedRev) {
    const current = this.rows.get(id);
    if (!current || current.rev !== expectedRev) return { conflict: true };
    this.rows.set(id, row);
    return { conflict: false, row };
  }
}

function makeSong(overrides = {}) {
  return {
    id: 'song-1',
    title: 'Open Song',
    lines: [{ id: 'line-1', lyrics: 'first verse', chords: [] }],
    bpm: 0, key: '', tuning: '', capo: 0, customChords: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const songById = (id) => useSongsStore.getState().songs.find((s) => s.id === id);

describe('store sync with the cloud repository', () => {
  let adapter;
  let repo;
  let android; // the other device

  beforeEach(async () => {
    localStorage.clear();
    clearSession();
    establishDEK(await generateContentKey());
    adapter = new FakeRemoteAdapter();
    android = new CloudSongsRepository({ adapter, userId: 'user-1', cacheKey: 'android', debounceMs: 20 });
    await android.create(makeSong());

    // Long debounce: the tests push explicitly with flushPending().
    repo = new CloudSongsRepository({ adapter, userId: 'user-1', debounceMs: 60_000 });
    useSongsStore.getState().setRepo(repo);
    await useSongsStore.getState().hydrate();
    useSongsStore.getState().setActiveSong('song-1');
  });

  afterEach(() => {
    repo.cancelPending();
    repo.dispose();
    android.dispose();
  });

  async function editOnAndroid(changes) {
    await android.list();
    await android.update('song-1', makeSong(changes));
    await android.flushPending();
  }

  it('refresh() updates the open song when another device changed it', async () => {
    await editOnAndroid({ lines: [{ id: 'line-1', lyrics: 'edited on the phone', chords: [{ i: 0, c: 'G' }] }] });
    await useSongsStore.getState().refresh();
    expect(songById('song-1').lines[0].lyrics).toBe('edited on the phone');
    expect(useSongsStore.getState().activeSongId).toBe('song-1');
  });

  it('refresh() adds new songs and drops ones deleted elsewhere, moving off a deleted open song', async () => {
    await android.list();
    await android.create(makeSong({ id: 'song-2', title: 'From the phone' }));
    await android.remove('song-1');
    await useSongsStore.getState().refresh();
    expect(useSongsStore.getState().songs.map((s) => s.id)).toEqual(['song-2']);
    expect(useSongsStore.getState().activeSongId).toBe('song-2');
  });

  // A store edit is encrypted asynchronously before it's queued for pushing.
  const queued = () => vi.waitFor(() => expect(repo._debounce.has('song-1')).toBe(true));

  it('refresh() never replaces a song with unsent typing; the push that follows merges both edits', async () => {
    useSongsStore.getState().renameSong('song-1', 'Typed here');
    await queued();
    await editOnAndroid({ lines: [{ id: 'line-1', lyrics: 'verse fixed on the phone', chords: [] }] });

    await useSongsStore.getState().refresh();
    expect(songById('song-1').title).toBe('Typed here');
    expect(songById('song-1').lines[0].lyrics).toBe('first verse');

    await repo.flushPending();
    expect(songById('song-1').title).toBe('Typed here');
    expect(songById('song-1').lines[0].lyrics).toBe('verse fixed on the phone');
    expect(useSongsStore.getState().songs).toHaveLength(1);
    expect(useSongsStore.getState().activeSongId).toBe('song-1');
    expect(adapter.rows.size).toBe(1);
  });

  it('after a merge, further edits of the song save on top of it', async () => {
    useSongsStore.getState().renameSong('song-1', 'Mine');
    await queued();
    await editOnAndroid({ bpm: 120 });
    await editOnAndroid({ bpm: 120, key: 'D' });
    await repo.flushPending();

    useSongsStore.getState().renameSong('song-1', 'Mine, renamed again');
    await queued();
    await repo.flushPending();

    expect(adapter.rows.size).toBe(1);
    const [onThePhone] = await android.list();
    expect(onThePhone).toMatchObject({ title: 'Mine, renamed again', bpm: 120, key: 'D' });
  });

  it('a delete here gives way to an edit made on the phone: the song comes back', async () => {
    await editOnAndroid({ lines: [{ id: 'line-1', lyrics: 'still writing this one', chords: [] }] });

    useSongsStore.getState().deleteSong('song-1');
    expect(useSongsStore.getState().songs).toHaveLength(0);

    await vi.waitFor(() => expect(useSongsStore.getState().songs.map((x) => x.id)).toEqual(['song-1']));
    expect(songById('song-1').lines[0].lyrics).toBe('still writing this one');
    expect(adapter.rows.get('song-1').deleted_at).toBeNull();
  });
});

describe('store bpm/capo', () => {
  beforeEach(() => {
    localStorage.clear();
    useSongsStore.setState({ songs: [], activeSongId: null, status: 'idle', error: null, repo: new LocalSongsRepository() });
  });

  it('new songs start at 0, and typed or imported values are stored as numbers', () => {
    const id = useSongsStore.getState().addSong('Meta');
    expect(songById(id)).toMatchObject({ bpm: 0, capo: 0 });
    useSongsStore.getState().updateSongMeta(id, { bpm: '92', capo: '3' });
    expect(songById(id)).toMatchObject({ bpm: 92, capo: 3 });
    useSongsStore.getState().updateSongMeta(id, { bpm: '', key: 'G' });
    expect(songById(id)).toMatchObject({ bpm: 0, capo: 3, key: 'G' });
  });
});

describe('startForegroundRefresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes on focus, on the tab being shown, and on an interval, at most every few seconds', () => {
    const refresh = vi.fn();
    const stop = startForegroundRefresh(refresh);

    window.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled(); // just hydrated

    vi.advanceTimersByTime(6_000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange')); // fires alongside focus
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 3);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('skips while the tab is hidden', () => {
    const refresh = vi.fn();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const stop = startForegroundRefresh(refresh);
    vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    stop();
    visibility.mockRestore();
  });
});
