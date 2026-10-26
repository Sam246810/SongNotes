import {
  STAMPED_FIELDS,
  validStamp,
  fieldStamp,
  chordStamp,
  lineStamp,
  sortedChords,
  lineContentEquals,
  canonicalJson,
  voicingEquals,
} from './editStamps';
import { tokenize, diff3 } from './tokenDiff3';

/**
 * Three-way merge of two devices' versions of one song against the version
 * both started from (docs/SYNC-MERGE.md has the rules in plain words and
 * worked examples; WIRE-FORMAT-v2.md section 5 the algorithm).
 *
 *   mergeSongs(base, local, remote) -> song
 *
 * `base` may be null when it isn't known (songs edited before bases were
 * stored): then nothing can be recognised as deleted, so everything either
 * side has is kept.
 *
 * Pure and deterministic, so a fixture file (spec/song-merge.json) pins this
 * and Android's core/domain/.../merge/SongMerge.kt to the same results. With
 * a base it's also symmetric: merge(b, L, R) and merge(b, R, L) are the same
 * song. Nothing either side wrote is dropped except what the other side
 * deliberately changed or deleted and this side didn't touch.
 */
export function mergeSongs(base, local, remote) {
  const { fieldEditedAt: _f, customChordsEditedAt: _c, ...rest } = local;
  const out = { ...rest };

  out.createdAt = pickDate(local.createdAt, remote.createdAt, -1);
  out.updatedAt = pickDate(local.updatedAt, remote.updatedAt, 1);

  const fieldEditedAt = {};
  for (const f of STAMPED_FIELDS) {
    const pick = merge3({
      hasBase: Boolean(base),
      b: base?.[f],
      l: local[f],
      r: remote[f],
      equals: (x, y) => x === y,
      lStamp: fieldStamp(local, f),
      rStamp: fieldStamp(remote, f),
      canon: (x) => JSON.stringify(x),
    });
    out[f] = pick === 'r' ? remote[f] : local[f];
    const stamp = chosenStamp(pick, validStamp(local.fieldEditedAt?.[f]), validStamp(remote.fieldEditedAt?.[f]));
    if (stamp !== undefined) fieldEditedAt[f] = stamp;
  }
  if (Object.keys(fieldEditedAt).length > 0) out.fieldEditedAt = fieldEditedAt;

  const { customChords, customChordsEditedAt } = mergeCustomChords(base, local, remote);
  out.customChords = customChords;
  if (Object.keys(customChordsEditedAt).length > 0) out.customChordsEditedAt = customChordsEditedAt;

  out.lines = mergeLines(base, local, remote);
  return out;
}

// -- Values (fields, custom chords) ----------------------------------------

/**
 * Which side's value a three-way merge keeps: 'l' or 'r', or 'same' when the
 * two sides agree. Only one side changed it -> that side. Both changed it
 * differently -> the larger stamp, then the greater canonical form.
 */
function merge3({ hasBase, b, l, r, equals, lStamp, rStamp, canon }) {
  if (equals(l, r)) return 'same';
  if (hasBase && equals(l, b)) return 'r';
  if (hasBase && equals(r, b)) return 'l';
  if (lStamp !== rStamp) return lStamp > rStamp ? 'l' : 'r';
  return canon(l) > canon(r) ? 'l' : 'r';
}

function chosenStamp(pick, l, r) {
  if (pick === 'l') return l;
  if (pick === 'r') return r;
  if (l === undefined) return r;
  if (r === undefined) return l;
  return Math.max(l, r);
}

function mergeCustomChords(base, local, remote) {
  const b = base?.customChords ?? {};
  const l = local.customChords ?? {};
  const r = remote.customChords ?? {};
  const names = [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort();
  const customChords = {};
  const customChordsEditedAt = {};
  for (const name of names) {
    let pick;
    if (!base && (l[name] === undefined) !== (r[name] === undefined)) {
      // No base: a voicing only one side has can't be told apart from one the
      // other side removed -- keep it.
      pick = l[name] === undefined ? 'r' : 'l';
    } else {
      pick = merge3({
        hasBase: Boolean(base),
        b: b[name],
        l: l[name],
        r: r[name],
        equals: voicingEquals,
        lStamp: chordStamp(local, name),
        rStamp: chordStamp(remote, name),
        canon: canonicalJson,
      });
    }
    const value = pick === 'r' ? r[name] : l[name];
    if (value !== undefined) customChords[name] = value;
    const stamp = chosenStamp(
      pick,
      validStamp(local.customChordsEditedAt?.[name]),
      validStamp(remote.customChordsEditedAt?.[name]),
    );
    if (stamp !== undefined) customChordsEditedAt[name] = stamp;
  }
  // Removal stamps for names no side has any more still have to survive.
  for (const song of [local, remote]) {
    for (const [name, stamp] of Object.entries(song.customChordsEditedAt ?? {})) {
      if (!names.includes(name) && validStamp(stamp) !== undefined) {
        customChordsEditedAt[name] = Math.max(customChordsEditedAt[name] ?? 0, stamp);
      }
    }
  }
  return { customChords, customChordsEditedAt: sortKeys(customChordsEditedAt) };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function pickDate(a, b, direction) {
  const ma = Date.parse(a ?? '');
  const mb = Date.parse(b ?? '');
  if (!Number.isFinite(ma)) return b;
  if (!Number.isFinite(mb)) return a;
  if (ma !== mb) return (ma - mb) * direction > 0 ? a : b;
  return (a > b ? 1 : -1) * direction > 0 ? a : b;
}

// -- Lines -----------------------------------------------------------------

const HEAD = '\u0000head';

function mergeLines(base, local, remote) {
  const L = local.lines;
  const R = remote.lines;
  const lById = new Map(L.map((l) => [l.id, l]));
  const rById = new Map(R.map((l) => [l.id, l]));
  const bById = base ? new Map(base.lines.map((l) => [l.id, l])) : null;
  // Without a base, the lines both sides have stand in for it (in local's
  // order) -- with no way to tell a deletion from an addition.
  const baseIds = base ? base.lines.map((l) => l.id) : L.filter((l) => rById.has(l.id)).map((l) => l.id);
  const baseIdSet = new Set(baseIds);

  const taken = new Set([...baseIds, ...lById.keys(), ...rById.keys()]);
  const ctx = { local, remote, lById, rById, taken };

  // Each surviving base line, and the losing version of a clash right after it.
  const resolved = new Map();
  for (const id of baseIds) {
    const l = lById.get(id);
    const r = rById.get(id);
    const b = bById?.get(id) ?? null;
    if (l && r) resolved.set(id, mergeLineContent(b, l, r, ctx));
    else if (l && !lineContentEquals(l, b)) resolved.set(id, [l]); // deleted remotely, edited here
    else if (r && !lineContentEquals(r, b)) resolved.set(id, [r]); // deleted here, edited remotely
  }

  // Lines added on one side, grouped by the base line they follow there.
  const lGroups = addedGroups(L, baseIdSet);
  const rGroups = addedGroups(R, baseIdSet);
  // An added id on both sides (a clash's losing line both devices produced,
  // or old lines without a base) is one line, merged without a base.
  const addedOnBoth = new Map();
  for (const line of L) {
    if (!baseIdSet.has(line.id) && rById.has(line.id)) {
      addedOnBoth.set(line.id, mergeLineContent(null, line, rById.get(line.id), ctx));
    }
  }

  const out = [];
  const emitted = new Set();
  const emit = (lines) => {
    for (const line of lines) {
      if (emitted.has(line.id)) continue;
      emitted.add(line.id);
      out.push(line);
    }
  };
  const emitGroups = (anchor) => {
    const gl = lGroups.get(anchor) ?? [];
    const gr = rGroups.get(anchor) ?? [];
    let first = gl;
    let second = gr;
    if (gl.length > 0 && gr.length > 0) {
      const sl = lineStamp(local, gl[0]);
      const sr = lineStamp(remote, gr[0]);
      const remoteFirst = sl !== sr ? sr < sl : gr[0].id < gl[0].id;
      if (remoteFirst) [first, second] = [gr, gl];
    }
    for (const line of [...first, ...second]) emit(addedOnBoth.get(line.id) ?? [line]);
  };

  emitGroups(HEAD);
  for (const id of baseIds) {
    if (resolved.has(id)) emit(resolved.get(id));
    emitGroups(id);
  }
  return out;
}

function addedGroups(lines, baseIdSet) {
  const groups = new Map();
  let anchor = HEAD;
  for (const line of lines) {
    if (baseIdSet.has(line.id)) {
      anchor = line.id;
    } else {
      if (!groups.has(anchor)) groups.set(anchor, []);
      groups.get(anchor).push(line);
    }
  }
  return groups;
}

/** A line both sides have: [merged] or, on a true clash, [winner, loser]. */
function mergeLineContent(b, l, r, ctx) {
  if (b && lineContentEquals(l, b)) return [r];
  if (b && lineContentEquals(r, b)) return [l];
  const stamp = chosenStamp('same', validStamp(l.editedAt), validStamp(r.editedAt));
  if (lineContentEquals(l, r)) return [withEditedAt(l, stamp)];

  const lStamp = lineStamp(ctx.local, l);
  const rStamp = lineStamp(ctx.remote, r);
  if (b) {
    const merged = mergeLineText(b, l, r, lStamp, rStamp);
    if (merged) return [withEditedAt({ id: l.id, lyrics: merged.lyrics, chords: merged.chords }, stamp)];
  }

  // True clash: keep both. The newer edit keeps the id and goes first.
  let lWins;
  if (lStamp !== rStamp) lWins = lStamp > rStamp;
  else if (l.lyrics !== r.lyrics) lWins = l.lyrics > r.lyrics;
  else lWins = canonicalJson(sortedChords(l.chords)) > canonicalJson(sortedChords(r.chords));
  const winner = lWins ? l : r;
  const loser = lWins ? r : l;
  const loserId = clashLoserId(l.id, loser, ctx);
  if (loserId === null) return [winner]; // already present as its own line
  return [winner, { ...loser, id: loserId }];
}

function withEditedAt(line, stamp) {
  const { editedAt: _drop, ...rest } = line;
  return stamp === undefined ? rest : { ...rest, editedAt: stamp };
}

/**
 * The id the losing version of a clash gets. Derived from its content, so two
 * devices resolving the same clash produce the same line rather than two.
 * Null if a line with that id and content already exists on either side (it
 * was produced by an earlier merge and is emitted as an added line).
 */
function clashLoserId(id, loser, ctx) {
  const root = id.includes('~') ? id.slice(0, id.indexOf('~')) : id;
  const canonical = `${root}~${fnv1a32(`${loser.lyrics}\u0000${canonicalJson(sortedChords(loser.chords))}`)}`;
  for (const existing of [ctx.lById.get(canonical), ctx.rById.get(canonical)]) {
    if (existing && lineContentEquals(existing, loser)) return null;
  }
  let candidate = canonical;
  for (let n = 2; ctx.taken.has(candidate); n++) candidate = `${canonical}~${n}`;
  ctx.taken.add(candidate);
  return candidate;
}

/** FNV-1a, 32-bit, over UTF-16 code units; 8 lowercase hex digits. */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// -- One line's words and chords -------------------------------------------

/**
 * Word-level merge of a line both sides edited, with each chord carried along
 * with the word it sits on. Null when both sides changed the same words
 * differently (or the line is too long to diff) -- a clash.
 */
function mergeLineText(b, l, r, lStamp, rStamp) {
  const TB = tokenize(b.lyrics);
  const TL = tokenize(l.lyrics);
  const TR = tokenize(r.lyrics);
  const chunks = diff3(TB, TL, TR);
  if (!chunks || chunks.some((c) => !c.stable && c.take === null)) return null;

  const sides = {
    b: sideInfo(b, TB, chunks, 'b'),
    l: sideInfo(l, TL, chunks, 'l'),
    r: sideInfo(r, TR, chunks, 'r'),
  };
  const newer = lStamp !== rStamp ? (lStamp > rStamp ? 'l' : 'r') : null;
  const pickChordSet = (vb, vl, vr) => {
    if (vl === vr) return vl;
    if (vl === vb) return vr;
    if (vr === vb) return vl;
    if (newer) return newer === 'l' ? vl : vr;
    return vl > vr ? vl : vr;
  };

  let lyrics = '';
  const chords = [];
  chunks.forEach((chunk, k) => {
    const from = chunk.stable ? 'l' : chunk.take;
    const tokens = from === 'l' ? TL : TR;
    const [s, e] = chunk[from];
    const text = tokens.slice(s, e).join('');
    const outStart = lyrics.length;
    lyrics += text;

    if (chunk.stable) {
      // Same words on all three sides: merge chord by chord position.
      const keys = new Set([...sides.b.chunks[k].keys(), ...sides.l.chunks[k].keys(), ...sides.r.chunks[k].keys()]);
      for (const offset of keys) {
        const set = pickChordSet(
          sides.b.chunks[k].get(offset) ?? '',
          sides.l.chunks[k].get(offset) ?? '',
          sides.r.chunks[k].get(offset) ?? '',
        );
        pushChords(chords, outStart + offset, set);
      }
      return;
    }

    // Words changed here: the changing side's chords come with its words,
    // unless the other side also changed chords in this span -- then the newer
    // edit's chords win, kept inside the span.
    const other = from === 'l' ? 'r' : 'l';
    const regionB = regionKey(sides.b.chunks[k]);
    const regionX = regionKey(sides[from].chunks[k]);
    const regionY = regionKey(sides[other].chunks[k]);
    let winner = from;
    if (regionY !== regionB && regionY !== regionX) {
      if (newer) winner = newer;
      else winner = regionX > regionY ? from : other;
    }
    const clampTo = Math.max(text.length - 1, 0);
    for (const [offset, set] of sides[winner].chunks[k]) {
      pushChords(chords, outStart + (winner === from ? offset : Math.min(offset, clampTo)), set);
    }
  });

  // Chords past the end of the lyrics (a chord-only tail): by overshoot.
  const endKeys = new Set([...sides.b.end.keys(), ...sides.l.end.keys(), ...sides.r.end.keys()]);
  for (const overshoot of endKeys) {
    const set = pickChordSet(
      sides.b.end.get(overshoot) ?? '',
      sides.l.end.get(overshoot) ?? '',
      sides.r.end.get(overshoot) ?? '',
    );
    pushChords(chords, lyrics.length + overshoot, set);
  }

  return { lyrics, chords: sortedChords(chords) };
}

// Chord names at one position, as one comparable string ('' = none). Names
// can't contain '\u0001'.
function chordSetKey(names) {
  return [...names].sort().join('\u0001');
}

function pushChords(out, i, set) {
  if (set === '') return;
  for (const c of set.split('\u0001')) out.push({ i, c });
}

function regionKey(map) {
  return [...map.entries()].sort(([a], [b]) => a - b).map(([o, s]) => `${o}:${s}`).join('\u0002');
}

/**
 * One side's chords, bucketed per chunk as offset-within-chunk -> chord set,
 * plus chords past the end of the lyrics as overshoot -> chord set.
 */
function sideInfo(line, tokens, chunks, side) {
  const starts = [0];
  for (const t of tokens) starts.push(starts[starts.length - 1] + t.length);
  const ranges = chunks.map((c) => [starts[c[side][0]], starts[c[side][1]]]);
  const byChunk = chunks.map(() => new Map());
  const end = new Map();
  const length = line.lyrics.length;
  const collect = (map, key, c) => map.set(key, [...(map.get(key) ?? []), c]);
  for (const { i, c } of line.chords ?? []) {
    if (i >= length) {
      collect(end, i - length, c);
      continue;
    }
    const k = ranges.findIndex(([s, e]) => i >= s && i < e);
    collect(byChunk[k], i - ranges[k][0], c);
  }
  const finish = (map) => new Map([...map].map(([key, names]) => [key, chordSetKey(names)]));
  return { chunks: byChunk.map(finish), end: finish(end) };
}
