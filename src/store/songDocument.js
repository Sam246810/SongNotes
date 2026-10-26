import { chordsLineToAnchors } from '../utils/chordAnchors';
import { STAMPED_FIELDS, validStamp } from '../sync/editStamps';

/**
 * The song document: the plaintext JSON both apps encrypt into a row's
 * `content` (docs/WIRE-FORMAT-v2.md section 4). One writer and one reader,
 * so what the web app sends and what it accepts are defined in one place --
 * and checked against spec/song-documents.json, the same cases the Android
 * app's reader runs.
 */

/**
 * `bpm`/`capo` as a whole number, 0 meaning unset. Older web rows hold them
 * as strings ('' or "92"), and a meta-bar or import value arrives as typed
 * text, so anything that isn't a positive whole number reads as 0.
 */
export function toMetaNumber(value) {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Valid edit stamps from `stamps` (keys limited to `allowed` when given),
 * sorted by key; undefined when there are none. See src/sync/editStamps.js.
 */
function stampMap(stamps, allowed) {
  if (!stamps || typeof stamps !== 'object') return undefined;
  const entries = Object.entries(stamps)
    .filter(([k, v]) => (!allowed || allowed.includes(k)) && validStamp(v) !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function lineToDocument(l) {
  const line = { id: l.id, lyrics: l.lyrics, chords: l.chords };
  if (validStamp(l.editedAt) !== undefined) line.editedAt = l.editedAt;
  return line;
}

/** The document for `song`, exactly as it's encrypted. */
export function songToDocument(song) {
  const doc = {
    title: song.title,
    lines: song.lines.map(lineToDocument),
    bpm: toMetaNumber(song.bpm),
    key: song.key || '',
    tuning: song.tuning || '',
    capo: toMetaNumber(song.capo),
    createdAt: song.createdAt,
    updatedAt: song.updatedAt,
  };
  if (song.customChords && Object.keys(song.customChords).length > 0) doc.customChords = song.customChords;
  const fieldEditedAt = stampMap(song.fieldEditedAt, STAMPED_FIELDS);
  if (fieldEditedAt) doc.fieldEditedAt = fieldEditedAt;
  const customChordsEditedAt = stampMap(song.customChordsEditedAt);
  if (customChordsEditedAt) doc.customChordsEditedAt = customChordsEditedAt;
  return doc;
}

/**
 * The app's song for document `doc` stored under row id `id`. Accepts the
 * legacy shapes still found in old rows: a line's `chords` as v1's padded
 * string, a line with no `id` (given `legacy-<index>`, stable across reads,
 * so it's saved under that id the next time the song is), and `bpm`/`capo`
 * as strings.
 */
export function songFromDocument(id, doc) {
  const song = {
    id,
    title: doc.title ?? '',
    lines: (doc.lines ?? []).map((l, index) => {
      const line = {
        id: l.id || `legacy-${index}`,
        lyrics: l.lyrics ?? '',
        chords: Array.isArray(l.chords) ? l.chords.map(({ i, c }) => ({ i, c })) : chordsLineToAnchors(l.chords),
      };
      if (validStamp(l.editedAt) !== undefined) line.editedAt = l.editedAt;
      return line;
    }),
    bpm: toMetaNumber(doc.bpm),
    key: doc.key ?? '',
    tuning: doc.tuning ?? '',
    capo: toMetaNumber(doc.capo),
    customChords: doc.customChords ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  const fieldEditedAt = stampMap(doc.fieldEditedAt, STAMPED_FIELDS);
  if (fieldEditedAt) song.fieldEditedAt = fieldEditedAt;
  const customChordsEditedAt = stampMap(doc.customChordsEditedAt);
  if (customChordsEditedAt) song.customChordsEditedAt = customChordsEditedAt;
  return song;
}
