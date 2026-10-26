import { describe, it, expect } from 'vitest';
import { mergeSongs, fnv1a32 } from '../sync/songMerge';
import { tokenize, diff3, matchTokens } from '../sync/tokenDiff3';
import { stampEdits, contentEquals, canonicalJson } from '../sync/editStamps';
import { songFromDocument, songToDocument } from '../store/songDocument';
import { cases, tokenizeVectors } from './fixtures/songMergeCases';

const read = (id, d) => (d ? songFromDocument(id, d) : null);
const mergeCase = (c, swap = false) => {
  const [l, r] = swap ? [c.remote, c.local] : [c.local, c.remote];
  return mergeSongs(read(c.id, c.base), read(c.id, l), read(c.id, r));
};
const chordString = (line) => line.chords.map(({ i, c }) => `${c}@${i}`).join(' ');

function lineMatches(spec, line) {
  const [idSpec, lyrics] = spec.includes(':') ? [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)] : [spec, undefined];
  const idOk = idSpec.endsWith('~*') ? line.id.startsWith(idSpec.slice(0, -1)) && line.id.length > idSpec.length - 1 : line.id === idSpec;
  return idOk && (lyrics === undefined || line.lyrics === lyrics);
}

describe('mergeSongs: shared cases (spec/song-merge.json)', () => {
  it.each(cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    const merged = mergeCase(c);
    const e = c.expect;
    if (e.lines) {
      expect(merged.lines.map((l) => `${l.id}:${l.lyrics}`)).toHaveLength(e.lines.length);
      e.lines.forEach((spec, k) => {
        expect(lineMatches(spec, merged.lines[k]), `line ${k}: expected ${spec}, got ${merged.lines[k].id}:${merged.lines[k].lyrics}`).toBe(true);
      });
    }
    if (e.lineCount !== undefined) expect(merged.lines).toHaveLength(e.lineCount);
    for (const [id, chords] of Object.entries(e.chords ?? {})) {
      expect(chordString(merged.lines.find((l) => l.id === id))).toBe(chords);
    }
    for (const [id, stamp] of Object.entries(e.editedAt ?? {})) {
      expect(merged.lines.find((l) => l.id === id).editedAt).toBe(stamp);
    }
    for (const field of ['title', 'bpm', 'key', 'tuning', 'capo', 'createdAt', 'updatedAt']) {
      if (field in e) expect(merged[field]).toBe(e[field]);
    }
    if (e.customChords) expect(merged.customChords).toEqual(e.customChords);
  });

  it.each(cases.filter((c) => c.symmetric).map((c) => [c.name, c]))('symmetric: %s', (_name, c) => {
    expect(canonicalJson(songToDocument(mergeCase(c, true)))).toBe(canonicalJson(songToDocument(mergeCase(c))));
  });

  it.each(cases.filter((c) => c.base).map((c) => [c.name, c]))('merging a side with itself changes nothing: %s', (_name, c) => {
    const base = read(c.id, c.base);
    const local = read(c.id, c.local);
    const remote = read(c.id, c.remote);
    expect(contentEquals(mergeSongs(base, local, local), local)).toBe(true);
    expect(contentEquals(mergeSongs(base, base, remote), remote)).toBe(true);
    expect(contentEquals(mergeSongs(base, local, base), local)).toBe(true);
  });

  it('merging the merged result again is stable (no ping-pong)', () => {
    for (const c of cases.filter((x) => x.base)) {
      const merged = mergeCase(c);
      const again = mergeSongs(read(c.id, c.remote), merged, read(c.id, c.remote));
      expect(contentEquals(again, merged), c.name).toBe(true);
    }
  });

  it('the clash copy id is derived from its content, so devices agree on it', () => {
    const c = cases.find((x) => x.name.startsWith('same words changed differently'));
    const loser = mergeCase(c).lines.find((l) => l.id.startsWith('b~'));
    expect(loser.id).toBe(`b~${fnv1a32(`${loser.lyrics}\u0000[]`)}`);
  });
});

describe('tokenize', () => {
  it.each(tokenizeVectors.map((t) => [JSON.stringify(t), t]))('round-trips %s', (_label, text) => {
    expect(tokenize(text).join('')).toBe(text);
  });

  it('splits words, whitespace runs and punctuation; keeps apostrophes and surrogate pairs in words', () => {
    expect(tokenize("Don't stop,  now!")).toEqual(["Don't", ' ', 'stop', ',', '  ', 'now', '!']);
    expect(tokenize('😀 hi')).toEqual(['😀', ' ', 'hi']);
    expect(tokenize('a b')).toEqual(['a', ' ', 'b']);
  });
});

describe('diff3', () => {
  it('marks a chunk both sides changed differently as a conflict', () => {
    const chunks = diff3(['a', ' ', 'b'], ['a', ' ', 'x'], ['a', ' ', 'y']);
    expect(chunks.find((c) => !c.stable).take).toBe(null);
  });

  it('gives up (null) on lines beyond the LCS budget', () => {
    const big = Array.from({ length: 500 }, (_, k) => `t${k}`);
    expect(matchTokens(big, [...big].reverse())).toBe(null);
  });
});

describe('stampEdits', () => {
  const prev = {
    id: 's', title: 'T', bpm: 0, key: '', tuning: '', capo: 0, customChords: {},
    lines: [{ id: 'a', lyrics: 'one', chords: [], editedAt: 100 }, { id: 'b', lyrics: 'two', chords: [] }],
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  it('stamps changed and new lines, keeps unchanged lines', () => {
    const next = stampEdits(prev, { ...prev, lines: [prev.lines[0], { id: 'b', lyrics: 'TWO', chords: [] }, { id: 'c', lyrics: 'new', chords: [] }] }, 5000);
    expect(next.lines.map((l) => l.editedAt)).toEqual([100, 5000, 5000]);
  });

  it('carries a stamp onto a rebuilt but unchanged line', () => {
    const next = stampEdits(prev, { ...prev, lines: [{ id: 'a', lyrics: 'one', chords: [] }, prev.lines[1]] }, 5000);
    expect(next.lines[0].editedAt).toBe(100);
  });

  it('stamps changed fields and custom chords, removals included', () => {
    const withChord = { ...prev, customChords: { G: { frets: [3, 2, 0, 0, 0, 3], baseFret: 1 } } };
    const next = stampEdits(withChord, { ...withChord, title: 'New', customChords: {} }, 7000);
    expect(next.fieldEditedAt).toEqual({ title: 7000 });
    expect(next.customChordsEditedAt).toEqual({ G: 7000 });
  });

  it('never goes backwards when the clock does', () => {
    const next = stampEdits(prev, { ...prev, lines: [{ id: 'a', lyrics: 'uno', chords: [] }, prev.lines[1]] }, 50);
    expect(next.lines[0].editedAt).toBe(101);
  });
});
