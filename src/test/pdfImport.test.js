import { describe, it, expect } from 'vitest';
import { reconstructPageText } from '../utils/pdfTextLayout';

/** Mimics the shape of a pdf.js TextContent item closely enough for reconstructPageText. */
function makeItem(str, x, y, charWidth = 6) {
  return {
    str,
    transform: [1, 0, 0, 1, x, y],
    width: str.length * charWidth,
    height: 10,
  };
}

describe('reconstructPageText', () => {
  it('returns empty string for no usable items', () => {
    expect(reconstructPageText([])).toBe('');
    expect(reconstructPageText([makeItem('', 0, 0)])).toBe('');
  });

  it('normalizes away a shared page margin instead of importing it as leading whitespace', () => {
    // Every line on a real page starts well right of x=0 (the page margin) —
    // that margin must not show up as identical leading spaces on every line.
    const items = [
      makeItem('Hello', 100, 700),
      makeItem('World', 100, 680),
    ];
    expect(reconstructPageText(items)).toBe('Hello\nWorld');
  });

  it('preserves genuine relative indentation between rows', () => {
    // The chord sits 5 character-columns to the right of the lyric line's
    // margin — that difference is real content and must survive.
    const items = [
      makeItem('G#maj', 100 + 5 * 6, 700),
      makeItem('Amazing grace', 100, 680),
    ];
    expect(reconstructPageText(items)).toBe('     G#maj\nAmazing grace');
  });

  it('orders rows top-to-bottom by y position regardless of item order in the input', () => {
    const items = [
      makeItem('Second line', 50, 600),
      makeItem('First line', 50, 700),
    ];
    expect(reconstructPageText(items)).toBe('First line\nSecond line');
  });

  it('orders items left-to-right within a row regardless of input order', () => {
    const items = [
      makeItem('World', 50 + 6 * 6, 700),
      makeItem('Hello', 50, 700),
    ];
    expect(reconstructPageText(items)).toBe('Hello World');
  });

  it('groups items into the same row when y differs only slightly (sub-pixel font metrics)', () => {
    const items = [
      makeItem('Hello', 50, 700.2),
      makeItem('World', 50 + 6 * 6, 700.4),
    ];
    const lines = reconstructPageText(items).split('\n');
    expect(lines).toHaveLength(1);
  });

  it('separates items into different rows when y differs meaningfully', () => {
    const items = [
      makeItem('Hello', 50, 700),
      makeItem('World', 50, 685),
    ];
    const lines = reconstructPageText(items).split('\n');
    expect(lines).toHaveLength(2);
  });
});
