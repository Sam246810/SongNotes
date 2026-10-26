/**
 * Per-line and per-field "last edited" stamps (docs/SYNC-MERGE.md,
 * WIRE-FORMAT-v2.md section 4): what lets a merge tell which of two devices
 * changed a given line or field more recently, when both changed it.
 *
 * Stamps are integer epoch milliseconds. A song carries them as
 *   - `line.editedAt` on each line,
 *   - `song.fieldEditedAt` = { title?, bpm?, key?, tuning?, capo? },
 *   - `song.customChordsEditedAt` = { <chord name>: ms }, removals included.
 * Anything without a stamp (songs from before stamps existed, or written by an
 * older app version) counts as edited at the song's `updatedAt`.
 *
 * Mirrored by Android's core/domain/.../merge/EditStamps.kt -- keep them in step.
 */

export const STAMPED_FIELDS = ['title', 'bpm', 'key', 'tuning', 'capo'];

/** A valid stamp, or undefined: a non-negative whole number of ms. */
export function validStamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The song's `updatedAt` in ms -- every missing stamp's fallback. */
export function updatedMs(song) {
  const ms = Date.parse(song?.updatedAt ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

export function fieldStamp(song, field) {
  return validStamp(song.fieldEditedAt?.[field]) ?? updatedMs(song);
}

export function chordStamp(song, name) {
  return validStamp(song.customChordsEditedAt?.[name]) ?? updatedMs(song);
}

export function lineStamp(song, line) {
  return validStamp(line.editedAt) ?? updatedMs(song);
}

function compareAnchors(a, b) {
  return a.i - b.i || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0);
}

/** A line's chords in a canonical order, so equal chord sets compare equal. */
export function sortedChords(chords) {
  return [...(chords ?? [])].sort(compareAnchors);
}

export function chordsEqual(a, b) {
  if (a === b) return true;
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  const sa = sortedChords(a);
  const sb = sortedChords(b);
  return sa.every((x, k) => x.i === sb[k].i && x.c === sb[k].c);
}

/** Same words and same chords; ignores the id and the stamp. */
export function lineContentEquals(a, b) {
  return a === b || (a.lyrics === b.lyrics && chordsEqual(a.chords, b.chords));
}

/** Canonical JSON: object keys sorted at every level. */
export function canonicalJson(value) {
  if (value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function voicingEquals(a, b) {
  return a === b || canonicalJson(a) === canonicalJson(b);
}

/**
 * Same song content: title, meta, custom chords and lines (ids, words,
 * chords, order). Ignores stamps, createdAt/updatedAt and UI-only state --
 * the "did anything actually change" test every sync decision uses.
 */
export function contentEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (STAMPED_FIELDS.some((f) => a[f] !== b[f])) return false;
  const ca = a.customChords ?? {};
  const cb = b.customChords ?? {};
  const names = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  for (const name of names) if (!voicingEquals(ca[name], cb[name])) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((l, k) => l.id === b.lines[k].id && lineContentEquals(l, b.lines[k]));
}

function bump(previous, now) {
  return Math.max(now, (validStamp(previous) ?? -1) + 1);
}

/**
 * `next` with a fresh stamp on everything that differs from `prev`: each
 * changed field, custom chord (added, changed or removed) and line (new id,
 * or same id with different words/chords). Unchanged lines keep their stamp.
 * Stamps never go backwards on a device -- a changed item gets
 * max(now, its previous stamp + 1) -- so a clock set back can't make a newer
 * edit look older than the one it replaced.
 */
export function stampEdits(prev, next, now) {
  if (!prev) return next;

  let fieldEditedAt = next.fieldEditedAt ?? prev.fieldEditedAt;
  for (const f of STAMPED_FIELDS) {
    if (prev[f] !== next[f]) {
      fieldEditedAt = { ...fieldEditedAt, [f]: bump(fieldEditedAt?.[f], now) };
    }
  }

  let customChordsEditedAt = next.customChordsEditedAt ?? prev.customChordsEditedAt;
  const pc = prev.customChords ?? {};
  const nc = next.customChords ?? {};
  if (pc !== nc) {
    for (const name of new Set([...Object.keys(pc), ...Object.keys(nc)])) {
      if (!voicingEquals(pc[name], nc[name])) {
        customChordsEditedAt = { ...customChordsEditedAt, [name]: bump(customChordsEditedAt?.[name], now) };
      }
    }
  }

  let lines = next.lines;
  if (prev.lines !== next.lines) {
    const prevById = new Map(prev.lines.map((l) => [l.id, l]));
    lines = next.lines.map((line) => {
      const before = prevById.get(line.id);
      if (before && lineContentEquals(before, line)) {
        const kept = validStamp(line.editedAt) ?? validStamp(before.editedAt);
        return kept === line.editedAt ? line : withStamp(line, kept);
      }
      return { ...line, editedAt: bump(before?.editedAt, now) };
    });
  }

  const out = { ...next, lines };
  if (fieldEditedAt && Object.keys(fieldEditedAt).length > 0) out.fieldEditedAt = fieldEditedAt;
  if (customChordsEditedAt && Object.keys(customChordsEditedAt).length > 0) {
    out.customChordsEditedAt = customChordsEditedAt;
  }
  return out;
}

function withStamp(line, stamp) {
  if (stamp === undefined) {
    const { editedAt: _drop, ...rest } = line;
    return rest;
  }
  return { ...line, editedAt: stamp };
}
