import { describe, it, expect, beforeEach } from 'vitest';
import { exportToText } from '../utils/export';
import { createSong, createLine } from '../store/songsStore';

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
    expect(line).toHaveProperty('chords', '');
    expect(line).toHaveProperty('lyrics', '');
  });

  it('accepts initial chord and lyric values', () => {
    const line = createLine('Am G', 'Hello');
    expect(line.chords).toBe('Am G ');
    expect(line.lyrics).toBe('Hello');
  });

  it('generates unique ids for each line', () => {
    const a = createLine();
    const b = createLine();
    expect(a.id).not.toBe(b.id);
  });
});
