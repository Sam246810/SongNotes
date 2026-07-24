/**
 * Multi-clip track timeline logic.
 *
 * A track holds an ordered array of clips: { id, startTime, buffer, trimStart, trimEnd }.
 * `startTime` is the clip's position on the timeline (seconds); `trimStart`/`trimEnd` are
 * non-destructive trims off the front/back of `buffer` (the original recorded/imported
 * audio, never mutated). Later entries in the array are "on top" — when two clips on the
 * same track overlap, the later one is what's heard (and drawn) in the overlap region,
 * matching how every mainstream DAW handles same-track overlap (never summed).
 */

/** Floor so a trim drag can never collapse a clip to nothing. */
export const MIN_CLIP_DURATION_SEC = 0.05;

/** Effective (post-trim) duration of a clip, in seconds. */
export function clipDuration(clip) {
  return Math.max(0, clip.buffer.duration - (clip.trimStart || 0) - (clip.trimEnd || 0));
}

/**
 * Resolve a track's clips into a flat, non-overlapping list of audible segments —
 * `{ clip, segStart, segEnd }` in timeline seconds — with later clips cutting off
 * whatever earlier clips would otherwise occupy in the same range. Shared by the
 * playback scheduler (DAWPanel) and the export flattener (renderTrackClips) so both
 * agree on exactly what's audible where.
 */
export function computeAudibleSegments(clips) {
  if (!clips || clips.length === 0) return [];

  const boundarySet = new Set([0]);
  clips.forEach((c) => {
    const dur = clipDuration(c);
    if (dur <= 0) return;
    boundarySet.add(c.startTime);
    boundarySet.add(c.startTime + dur);
  });
  const boundaries = [...boundarySet].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    if (segEnd <= segStart) continue;

    const mid = (segStart + segEnd) / 2;
    let owner = null;
    for (let ci = clips.length - 1; ci >= 0; ci--) {
      const c = clips[ci];
      const dur = clipDuration(c);
      if (dur > 0 && mid >= c.startTime && mid < c.startTime + dur) {
        owner = c;
        break;
      }
    }
    if (!owner) continue;

    const prev = segments[segments.length - 1];
    if (prev && prev.clip === owner && Math.abs(prev.segEnd - segStart) < 1e-9) {
      prev.segEnd = segEnd;
    } else {
      segments.push({ clip: owner, segStart, segEnd });
    }
  }
  return segments;
}

/** Shorten a clip so its effective end lands at `end` (timeline seconds); null if that leaves nothing usable. */
function trimClipEnd(clip, end) {
  const newDuration = end - clip.startTime;
  if (newDuration < MIN_CLIP_DURATION_SEC) return null;
  const newTrimEnd = clip.buffer.duration - clip.trimStart - newDuration;
  return { ...clip, trimEnd: Math.max(0, newTrimEnd) };
}

/** Shorten a clip so its effective start lands at `start` (timeline seconds); null if that leaves nothing usable. */
function trimClipStart(clip, start) {
  const oldEnd = clip.startTime + clipDuration(clip);
  const newDuration = oldEnd - start;
  if (newDuration < MIN_CLIP_DURATION_SEC) return null;
  const newTrimStart = clip.trimStart + (start - clip.startTime);
  return { ...clip, trimStart: Math.max(0, newTrimStart), startTime: start };
}

/**
 * Insert a new clip into a track's clip list while enforcing that clips on the same
 * track never overlap — the behavior of every mainstream DAW's punch-in recording.
 * Any existing clip touching the new clip's range is trimmed to make room; one that's
 * split right down the middle becomes two remnants (before/after); one entirely
 * covered by the new clip is dropped. The user can still recover trimmed material
 * afterward by dragging the affected edge — see DAWPanel's neighbor-aware clamping on
 * clip move/trim — but it can only be dragged back up to where it would touch the new
 * clip again, never past it.
 */
export function insertClipNonOverlapping(clips, newClip) {
  const newStart = newClip.startTime;
  const newEnd = newStart + clipDuration(newClip);
  const EPS = 1e-9;
  const result = [];

  clips.forEach((c) => {
    const start = c.startTime;
    const end = start + clipDuration(c);

    if (end <= newStart + EPS || start >= newEnd - EPS) {
      result.push(c); // no overlap at all
      return;
    }
    if (start >= newStart - EPS && end <= newEnd + EPS) {
      return; // entirely covered by the new clip — nothing left of it
    }
    if (start < newStart && end > newEnd) {
      // the new clip punches a hole in the middle — split into before/after remnants
      const before = trimClipEnd(c, newStart);
      const after = trimClipStart({ ...c, id: `${c.id}-split-${newClip.id}` }, newEnd);
      if (before) result.push(before);
      if (after) result.push(after);
      return;
    }
    if (start < newStart) {
      const trimmed = trimClipEnd(c, newStart); // overlaps only at its tail
      if (trimmed) result.push(trimmed);
      return;
    }
    const trimmed = trimClipStart(c, newEnd); // overlaps only at its head
    if (trimmed) result.push(trimmed);
  });

  result.push(newClip);
  return result;
}

/**
 * Flatten a track's clips into a single AudioBuffer for export/mixing — silence where
 * there's no clip, each clip's audible segment written at its timeline position, with
 * overlap already resolved by computeAudibleSegments (so this never sums two clips).
 * Pass an AudioContext to allocate a real AudioBuffer; omitted/non-browser callers (e.g.
 * tests) get a plain object with the same getChannelData/duration shape.
 */
export function renderTrackClips(ctx, clips) {
  const segments = computeAudibleSegments(clips);
  if (segments.length === 0) return null;

  const sampleRate = ctx ? ctx.sampleRate : clips[0].buffer.sampleRate;
  const totalLen = Math.max(1, Math.round(segments[segments.length - 1].segEnd * sampleRate));

  let out;
  if (ctx && ctx.createBuffer) {
    out = ctx.createBuffer(1, totalLen, sampleRate);
  } else {
    const pcm = new Float32Array(totalLen);
    out = {
      numberOfChannels: 1,
      sampleRate,
      length: totalLen,
      duration: totalLen / sampleRate,
      getChannelData: () => pcm,
    };
  }
  const outData = out.getChannelData(0);

  segments.forEach(({ clip, segStart, segEnd }) => {
    const clipData = clip.buffer.getChannelData(0);
    const trimStartSample = Math.round((clip.trimStart || 0) * clip.buffer.sampleRate);
    const withinClipStartSample = trimStartSample + Math.round((segStart - clip.startTime) * clip.buffer.sampleRate);
    const outStartSample = Math.round(segStart * sampleRate);
    const len = Math.round((segEnd - segStart) * sampleRate);
    for (let i = 0; i < len; i++) {
      const srcIdx = withinClipStartSample + i;
      const dstIdx = outStartSample + i;
      if (srcIdx >= 0 && srcIdx < clipData.length && dstIdx < outData.length) {
        outData[dstIdx] = clipData[srcIdx];
      }
    }
  });

  return out;
}
