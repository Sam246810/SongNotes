import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Editor from '../components/Editor/Editor';
import AuthProvider from '../auth/AuthProvider';
import useSongsStore from '../store/songsStore';
import { LocalSongsRepository } from '../store/songsRepository';

// The editor wraps each line to the width it measures. jsdom has no layout,
// so give it a 12-column row: ResizeObserver reports the row's text width,
// and with no canvas the glyph width falls back to 9px.
const COLUMNS = 12;

class FixedWidthResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: COLUMNS * 9 + 2 } }]); }
  disconnect() {}
}

function lyricRows() {
  return screen.getAllByLabelText('Lyric input').map((el) => el.value);
}

function savedLines() {
  return useSongsStore.getState().songs[0].lines;
}

function caret() {
  const el = document.activeElement;
  return [screen.getAllByLabelText('Lyric input').indexOf(el), el.selectionStart];
}

function openSong(lines) {
  localStorage.clear();
  const song = { id: 's1', title: 'Song', lines, isReadOnly: false, customChords: {}, createdAt: '', updatedAt: '' };
  useSongsStore.setState({
    songs: [song], activeSongId: 's1', status: 'ready', error: null, repo: new LocalSongsRepository(),
  });
  render(<AuthProvider><Editor /></AuthProvider>);
}

async function typeAt(rowIndex, column, text) {
  const user = userEvent.setup();
  const el = screen.getAllByLabelText('Lyric input')[rowIndex];
  await user.click(el);
  act(() => el.setSelectionRange(column, column));
  await user.keyboard(text);
  return user;
}

describe('Editor: long lines wrap instead of splitting', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FixedWidthResizeObserver);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('wraps typing past the edge onto rows of the same saved line', async () => {
    openSong([{ id: 'p1', lyrics: '', chords: [] }]);
    await typeAt(0, 0, 'the quick brown fox jumps');
    expect(lyricRows()).toEqual(['the quick ', 'brown fox ', 'jumps']);
    expect(savedLines()).toEqual([{ id: 'p1', lyrics: 'the quick brown fox jumps', chords: [] }]);
    expect(caret()).toEqual([2, 5]);
  });

  it('flows words back up when text is deleted', async () => {
    openSong([{ id: 'p1', lyrics: 'the quick brown fox jumps', chords: [] }]);
    await typeAt(0, 4, '{Backspace}{Backspace}{Backspace}{Backspace}');
    expect(lyricRows()).toEqual(['quick brown ', 'fox jumps']);
    expect(caret()).toEqual([0, 0]);
  });

  it('opens an empty row for the caret after a word that exactly fills its row, and closes it on backspace', async () => {
    openSong([{ id: 'p1', lyrics: 'abcdef ghijk', chords: [] }]);
    const user = await typeAt(0, 12, ' ');
    expect(lyricRows()).toEqual(['abcdef ghijk ', '']);
    expect(caret()).toEqual([1, 0]);

    await user.keyboard('zz{Backspace}{Backspace}');
    expect(lyricRows()).toEqual(['abcdef ghijk ', '']);
    expect(caret()).toEqual([1, 0]);

    await user.keyboard('{Backspace}');
    expect(lyricRows()).toEqual(['abcdef ghijk']);
    expect(caret()).toEqual([0, 12]);
    expect(savedLines()).toHaveLength(1);
  });

  it('deletes the hanging space on backspace at the start of a wrapped row', async () => {
    openSong([{ id: 'p1', lyrics: 'the quick lazy dog', chords: [] }]);
    expect(lyricRows()).toEqual(['the quick ', 'lazy dog']);
    await typeAt(1, 5, '{Backspace}');
    expect(lyricRows()).toEqual(['the quick ', 'lazydog']);
    expect(caret()).toEqual([1, 4]);
  });

  it('splits on Enter (chords after the caret go along) and joins back on backspace at the line start', async () => {
    openSong([{ id: 'p1', lyrics: 'hello there world', chords: [{ i: 0, c: 'G' }, { i: 12, c: 'C' }] }]);
    const user = await typeAt(1, 0, '{Enter}');
    const [first, second] = savedLines();
    expect(first).toEqual({ id: 'p1', lyrics: 'hello there ', chords: [{ i: 0, c: 'G' }] });
    expect(second.id).not.toBe('p1');
    expect(second).toMatchObject({ lyrics: 'world', chords: [{ i: 0, c: 'C' }] });
    expect(caret()).toEqual([1, 0]);

    await user.keyboard('{Backspace}');
    expect(savedLines()).toEqual([{ id: 'p1', lyrics: 'hello there world', chords: [{ i: 0, c: 'G' }, { i: 12, c: 'C' }] }]);
    expect(caret()).toEqual([1, 0]);
  });

  it('does nothing on backspace at the start of the first line', async () => {
    openSong([{ id: 'p1', lyrics: 'abc', chords: [] }, { id: 'p2', lyrics: 'def', chords: [] }]);
    await typeAt(0, 0, '{Backspace}');
    expect(savedLines().map((l) => l.lyrics)).toEqual(['abc', 'def']);
  });

  it('keeps chords over their letters as typing re-wraps the line', async () => {
    openSong([{ id: 'p1', lyrics: 'the quick brown', chords: [{ i: 10, c: 'Am' }] }]);
    expect(screen.getAllByLabelText('Chord input').map((el) => el.value.trimEnd())).toEqual(['', 'Am']);
    await typeAt(0, 4, 'very ');
    expect(lyricRows()).toEqual(['the very ', 'quick brown']);
    expect(savedLines()[0].chords).toEqual([{ i: 15, c: 'Am' }]);
    expect(screen.getAllByLabelText('Chord input').map((el) => el.value.trimEnd())).toEqual(['', '      Am']);
  });
});
