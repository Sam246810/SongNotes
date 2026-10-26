// Checks this app's song-document reader against spec/song-documents.json --
// the cases SongNotes-Android's reader runs too, so both apps read every
// document (each other's, and the legacy shapes) the same way. Regenerate the
// file with src/test/generate-golden-fixtures.test.js.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { songFromDocument, songToDocument, toMetaNumber } from '../store/songDocument.js';

const cases = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../spec/song-documents.json'), 'utf-8'),
);

describe('spec/song-documents.json', () => {
  it('covers web-written, Android-written and legacy documents', () => {
    expect(cases.map((c) => c.name)).toEqual([
      expect.stringMatching(/^web app/),
      expect.stringMatching(/^Android app/),
      expect.stringMatching(/^legacy: chords as a v1 padded string/),
      expect.stringMatching(/^legacy: a line with no id/),
      expect.stringMatching(/^legacy: bpm\/capo as strings/),
    ]);
  });

  it.each(cases.map((c) => [c.name, c]))('reads %s', (_name, { id, document, expected }) => {
    expect(songFromDocument(id, document)).toEqual(expected);
  });

  it.each(cases.map((c) => [c.name, c]))('writes %s back in the current shape, reading the same', (_name, { id, expected }) => {
    const written = songToDocument(expected);
    expect(typeof written.bpm).toBe('number');
    expect(typeof written.capo).toBe('number');
    expect(written.lines.every((l) => typeof l.id === 'string' && Array.isArray(l.chords))).toBe(true);
    expect(written).not.toHaveProperty('meta');
    expect(written).not.toHaveProperty('id');
    expect(songFromDocument(id, written)).toEqual(expected);
  });
});

describe('toMetaNumber', () => {
  it.each([
    [92, 92], ['92', 92], [' 7 ', 7], ['', 0], [0, 0], [undefined, 0], [null, 0], ['abc', 0], [-3, 0], ['3.5', 3],
  ])('%j -> %j', (input, output) => {
    expect(toMetaNumber(input)).toBe(output);
  });
});
