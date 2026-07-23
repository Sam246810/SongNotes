import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalSongsRepository } from '../store/songsRepository';

describe('LocalSongsRepository Guest-to-Guest Isolation', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('tags new songs with the current sessionStorage guest ID and isolates list/get/remove', async () => {
    // 1. Simulating Guest A session
    sessionStorage.setItem('__songnotes_guest_session_id', 'guest-A');
    const repoA = new LocalSongsRepository();

    const song1 = { id: 'song-1', title: 'Song 1', lines: [] };
    const song2 = { id: 'song-2', title: 'Song 2', lines: [] };

    await repoA.create(song1);
    await repoA.create(song2);

    const listA = await repoA.list();
    expect(listA).toHaveLength(2);
    expect(listA[0].guestSessionId).toBe('guest-A');

    const fetchedA = await repoA.get('song-1');
    expect(fetchedA).not.toBeNull();
    expect(fetchedA.title).toBe('Song 1');

    // 2. Simulating Guest B session (new tab session, sessionStorage cleared/changed)
    sessionStorage.setItem('__songnotes_guest_session_id', 'guest-B');
    const repoB = new LocalSongsRepository();

    // Guest B list should be empty even though Guest A's songs are in localStorage
    const listB = await repoB.list();
    expect(listB).toHaveLength(0);

    const fetchedB = await repoB.get('song-1');
    expect(fetchedB).toBeNull(); // Guest B cannot access Guest A's song

    // Guest B creates a song
    const songB = { id: 'song-B', title: 'Song B', lines: [] };
    await repoB.create(songB);

    const listBUpdated = await repoB.list();
    expect(listBUpdated).toHaveLength(1);
    expect(listBUpdated[0].id).toBe('song-B');
    expect(listBUpdated[0].guestSessionId).toBe('guest-B');

    // 3. Simulating Guest A returning (restoring guest-A session ID)
    sessionStorage.setItem('__songnotes_guest_session_id', 'guest-A');
    const listAReturned = await repoA.list();
    expect(listAReturned).toHaveLength(2); // Guest A sees only their 2 songs, not Guest B's song

    // Guest A deletes song-1
    await repoA.remove('song-1');
    const listAAfterDelete = await repoA.list();
    expect(listAAfterDelete).toHaveLength(1);
    expect(listAAfterDelete[0].id).toBe('song-2');

    // Confirm Guest B's song was not touched
    sessionStorage.setItem('__songnotes_guest_session_id', 'guest-B');
    const listBFinal = await repoB.list();
    expect(listBFinal).toHaveLength(1);
    expect(listBFinal[0].id).toBe('song-B');
  });
});
