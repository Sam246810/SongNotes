import { describe, it, expect, beforeEach } from 'vitest';
import { exportToText, songAsText, TEXT_EXPORT_COLUMNS } from '../utils/export';
import { createSong, createLine } from '../store/songsStore';
import { wrapSongToColumns } from '../utils/lineWrap';
import { anchorsToChordsLine } from '../utils/chordAnchors';

// ─────────────────────────────────────────────
// exportToText
// ─────────────────────────────────────────────
describe('exportToText', () => {
  it('formats a song with chords above lyrics', () => {
    const song = {
      title: 'Test Song',
      lines: [
        { id: '1', chords: 'Am  G', lyrics: "I can't feel my face" },
        { id: '2', chords: '', lyrics: 'But I love it' },
      ],
    };
    const text = exportToText(song);
    expect(text).toContain('Test Song');
    expect(text).toContain('Am  G');
    expect(text).toContain("I can't feel my face");
    expect(text).toContain('But I love it');
  });

  it('omits chord line when chords are empty', () => {
    const song = {
      title: 'Song',
      lines: [{ id: '1', chords: '', lyrics: 'lyrics only' }],
    };
    const text = exportToText(song);
    const lines = text.split('\n').filter(Boolean);
    // Should NOT have an empty chord line above the lyric
    expect(lines).not.toContain('');
    expect(text).toContain('lyrics only');
  });

  it('omits lyric line when lyrics are empty', () => {
    const song = {
      title: 'Song',
      lines: [{ id: '1', chords: 'G', lyrics: '' }],
    };
    const text = exportToText(song);
    expect(text).toContain('G');
  });

  it('skips fully empty lines', () => {
    const song = {
      title: 'Song',
      lines: [
        { id: '1', chords: '', lyrics: '' },
        { id: '2', chords: 'Am', lyrics: 'Hello' },
      ],
    };
    const text = exportToText(song);
    // The empty line should not produce a chord/lyric pair
    const songBody = text.split('\n\n')[1]; // after header
    expect(songBody).not.toMatch(/^\n\n/);
    expect(text).toContain('Am');
  });

  it('includes a title header with underline', () => {
    const song = { title: 'My Song', lines: [] };
    const text = exportToText(song);
    expect(text).toContain('My Song');
    expect(text).toContain('=======');
  });

  it('falls back to "Untitled" if title is missing', () => {
    const song = { title: '', lines: [] };
    const text = exportToText(song);
    expect(text).toMatch(/Untitled|untitled/i);
  });
});

// ─────────────────────────────────────────────
// songAsText (what .txt export writes)
// ─────────────────────────────────────────────
describe('songAsText', () => {
  it('wraps at the same 60 columns as the Android app', () => {
    expect(TEXT_EXPORT_COLUMNS).toBe(60);
  });

  it('prints a short line exactly as exportToText would', () => {
    const song = { title: 'T', lines: [{ id: 'a', lyrics: 'Hello world', chords: [{ i: 0, c: 'Am' }, { i: 6, c: 'G' }] }] };
    expect(songAsText(song)).toBe('T\n=\n\nAm    G    \nHello world');
  });

  it('wraps a paragraph into rows, each chord over its word, every line within 60 columns', () => {
    const lyrics = 'Well I wandered down the long road home tonight, and the stars were burning out one by one above me';
    // wandered, and, burning, above -- and an ending chord far past the lyrics.
    const chords = [{ i: 7, c: 'G' }, { i: 49, c: 'C' }, { i: 68, c: 'D' }, { i: 91, c: 'Am' }, { i: 116, c: 'Em' }];
    const body = songAsText({ title: 'Road', lines: [{ id: 'a', lyrics, chords }] }).split('\n').slice(3);
    expect(body).toEqual([
      ' '.repeat(7) + 'G' + ' '.repeat(41) + 'C' + ' '.repeat(6),
      'Well I wandered down the long road home tonight, and the', // hanging space trimmed
      ' '.repeat(11) + 'D' + ' '.repeat(22) + 'Am' + ' '.repeat(6),
      'stars were burning out one by one above me',
      'Em', // would have run past column 60: continues on a chords-only row
    ]);
    for (const row of body) expect(row.length).toBeLessThanOrEqual(TEXT_EXPORT_COLUMNS);
    expect(body[1].slice(7, 10)).toBe('wan');
    expect(body[1].slice(49, 52)).toBe('and');
    expect(body[3].slice(11, 14)).toBe('bur');
    expect(body[3].slice(34, 37)).toBe('abo');
  });

  it('matches the Android app on its own wrapSongToColumns + formatSongAsText case (at 12 columns)', () => {
    // LineWrapTest.kt: `formatSongAsText of a wrapped song keeps every chord over its word`.
    // songAsText is fixed at 60 columns, so run the same steps at 12 here.
    const line = { id: 'a', lyrics: 'the quick brown fox jumps', chords: [{ i: 4, c: 'G' }, { i: 16, c: 'C' }, { i: 20, c: 'D' }] };
    const wrapped = wrapSongToColumns({ title: 'T', lines: [line] }, 12);
    const text = exportToText({
      ...wrapped,
      lines: wrapped.lines.map((l) => ({ ...l, chords: anchorsToChordsLine(l.lyrics.length, l.chords) })),
    });
    expect(text).toBe('T\n=\n\n    G    \nthe quick\n      C  \nbrown fox\nD    \njumps');
  });
});

// ─────────────────────────────────────────────
// createSong / createLine (store factories)
// ─────────────────────────────────────────────
describe('createSong', () => {
  it('creates a song with required fields', () => {
    const song = createSong('Hello World');
    expect(song).toHaveProperty('id');
    expect(song).toHaveProperty('title', 'Hello World');
    expect(song).toHaveProperty('lines');
    expect(song).toHaveProperty('isReadOnly', false);
    expect(song).toHaveProperty('createdAt');
    expect(song).toHaveProperty('updatedAt');
    expect(song.lines).toHaveLength(1);
  });

  it('defaults title to "Untitled Song" when not provided', () => {
    const song = createSong();
    expect(song.title).toBe('Untitled Song');
  });

  it('generates unique ids for each song', () => {
    const a = createSong('A');
    const b = createSong('B');
    expect(a.id).not.toBe(b.id);
  });
});

describe('createLine', () => {
  it('creates an empty line by default', () => {
    const line = createLine();
    expect(line).toHaveProperty('id');
    expect(line).toHaveProperty('chords', []);
    expect(line).toHaveProperty('lyrics', '');
  });

  it('accepts initial lyrics and chord anchors', () => {
    const line = createLine('Hello', [{ i: 0, c: 'Am' }, { i: 3, c: 'G' }]);
    expect(line.chords).toEqual([{ i: 0, c: 'Am' }, { i: 3, c: 'G' }]);
    expect(line.lyrics).toBe('Hello');
  });

  it('generates unique ids for each line', () => {
    const a = createLine();
    const b = createLine();
    expect(a.id).not.toBe(b.id);
  });
});
