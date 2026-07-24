import { describe, it, expect } from 'vitest';
import { computeAudibleSegments, renderTrackClips, insertClipNonOverlapping, clipDuration, MIN_CLIP_DURATION_SEC } from '../audio/clipEngine';

function makeBuffer(samples, sampleRate = 100) {
  const data = new Float32Array(samples);
  for (let i = 0; i < samples; i++) data[i] = i + 1; // distinct, easy-to-check values
  return {
    sampleRate,
    length: samples,
    duration: samples / sampleRate,
    getChannelData: () => data,
  };
}

function makeClip({ startTime, samples, trimStart = 0, trimEnd = 0, sampleRate = 100 }) {
  return {
    id: `${startTime}-${samples}`,
    startTime,
    buffer: makeBuffer(samples, sampleRate),
    trimStart,
    trimEnd,
  };
}

describe('clipEngine', () => {
  it('clipDuration subtracts both trims from the buffer duration', () => {
    const clip = makeClip({ startTime: 0, samples: 100, trimStart: 0.1, trimEnd: 0.2 });
    expect(clipDuration(clip)).toBeCloseTo(0.7); // 1.0s buffer - 0.1 - 0.2
  });

  it('a single clip produces one segment spanning its full (trimmed) duration', () => {
    const clip = makeClip({ startTime: 2, samples: 100 });
    const segments = computeAudibleSegments([clip]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ clip, segStart: 2, segEnd: 3 });
  });

  it('non-overlapping clips each get their own untouched segment', () => {
    const a = makeClip({ startTime: 0, samples: 100 }); // 0-1s
    const b = makeClip({ startTime: 2, samples: 100 }); // 2-3s
    const segments = computeAudibleSegments([a, b]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ clip: a, segStart: 0, segEnd: 1 });
    expect(segments[1]).toMatchObject({ clip: b, segStart: 2, segEnd: 3 });
  });

  it('later clip wins in an overlap — never sums, matches every mainstream DAW', () => {
    const older = makeClip({ startTime: 0, samples: 200 }); // 0-2s
    const newer = makeClip({ startTime: 1, samples: 200 }); // 1-3s, punched in over `older`
    const segments = computeAudibleSegments([older, newer]);
    // Expect: [0,1) older, [1,3) newer — the overlap [1,2) is entirely newer's.
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ clip: older, segStart: 0, segEnd: 1 });
    expect(segments[1]).toMatchObject({ clip: newer, segStart: 1, segEnd: 3 });
  });

  it('a clip fully covered by a later one produces no segment for the covered clip', () => {
    const covered = makeClip({ startTime: 1, samples: 50 }); // 1-1.5s
    const coveringTop = makeClip({ startTime: 0, samples: 300 }); // 0-3s, on top (later in array)
    const segments = computeAudibleSegments([covered, coveringTop]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ clip: coveringTop, segStart: 0, segEnd: 3 });
  });

  it('array order determines priority, not startTime — earlier-starting clip later in the array still wins', () => {
    const a = makeClip({ startTime: 0, samples: 200 }); // 0-2s, listed first
    const b = makeClip({ startTime: 0, samples: 200 }); // 0-2s, identical range, listed second (on top)
    const segments = computeAudibleSegments([a, b]);
    expect(segments).toHaveLength(1);
    expect(segments[0].clip).toBe(b);
  });

  it('trimmed clips only produce segments for the trimmed (audible) range', () => {
    const clip = makeClip({ startTime: 5, samples: 100, trimStart: 0.2, trimEnd: 0.3 }); // 1.0s buffer -> 0.5s audible
    const segments = computeAudibleSegments([clip]);
    expect(segments).toHaveLength(1);
    expect(segments[0].segStart).toBeCloseTo(5);
    expect(segments[0].segEnd).toBeCloseTo(5.5);
  });

  it('MIN_CLIP_DURATION_SEC is a small positive floor', () => {
    expect(MIN_CLIP_DURATION_SEC).toBeGreaterThan(0);
    expect(MIN_CLIP_DURATION_SEC).toBeLessThan(1);
  });

  describe('renderTrackClips', () => {
    it('returns null for an empty clip list', () => {
      expect(renderTrackClips(null, [])).toBeNull();
    });

    it('places a single clip at its startTime with silence before it', () => {
      const clip = makeClip({ startTime: 1, samples: 100 }); // values 1..100, at 1s (sample 100 @ 100Hz)
      const out = renderTrackClips(null, [clip]);
      const data = out.getChannelData(0);
      expect(data.length).toBe(200); // 1s silence + 1s of audio @ 100Hz
      expect(data[0]).toBe(0); // silent lead-in
      expect(data[99]).toBe(0);
      expect(data[100]).toBe(1); // first sample of the clip's buffer
      expect(data[199]).toBe(100); // last sample
    });

    it('overlap resolves to the later clip, not a sum, in the rendered output', () => {
      const older = makeClip({ startTime: 0, samples: 200 }); // values 1..200
      const newer = makeClip({ startTime: 1, samples: 200 }); // values 1..200, starts mid-older
      const out = renderTrackClips(null, [older, newer]);
      const data = out.getChannelData(0);
      // [0,1s) i.e. samples 0-99 come from `older` (values 1..100)
      expect(data[0]).toBe(1);
      expect(data[99]).toBe(100);
      // [1s, ...) i.e. sample 100 onward comes from `newer`, restarting at its own sample 0 (value 1)
      expect(data[100]).toBe(1);
      // never summed: if it had summed, sample 100 would be older[100]+newer[0] = 101+1 = 102
      expect(data[100]).not.toBe(102);
    });

    it('respects trim when rendering', () => {
      const clip = makeClip({ startTime: 0, samples: 100, trimStart: 0.2 }); // skip first 20 samples (values 1..20)
      const out = renderTrackClips(null, [clip]);
      const data = out.getChannelData(0);
      expect(data.length).toBe(80);
      expect(data[0]).toBe(21); // first post-trim sample
      expect(data[79]).toBe(100);
    });
  });

  describe('insertClipNonOverlapping', () => {
    it('with no existing clips, just adds the new one', () => {
      const newClip = makeClip({ startTime: 0, samples: 100 });
      const result = insertClipNonOverlapping([], newClip);
      expect(result).toEqual([newClip]);
    });

    it('leaves a non-overlapping existing clip untouched', () => {
      const existing = makeClip({ startTime: 0, samples: 100 }); // 0-1s
      const newClip = makeClip({ startTime: 2, samples: 100 }); // 2-3s
      const result = insertClipNonOverlapping([existing], newClip);
      expect(result).toEqual([existing, newClip]);
    });

    it('trims the tail of an existing clip the new one punches into', () => {
      const existing = makeClip({ startTime: 0, samples: 200 }); // 0-2s
      const newClip = makeClip({ startTime: 1, samples: 100 }); // 1-2s, punches into existing's tail
      const result = insertClipNonOverlapping([existing], newClip);
      expect(result).toHaveLength(2);
      const trimmedExisting = result.find(c => c.id === existing.id);
      expect(trimmedExisting.startTime).toBe(0);
      expect(clipDuration(trimmedExisting)).toBeCloseTo(1); // shortened to end exactly at newClip's start
      expect(result).toContainEqual(newClip);
      // no overlap survives
      expect(trimmedExisting.startTime + clipDuration(trimmedExisting)).toBeCloseTo(newClip.startTime);
    });

    it('trims the head of an existing clip the new one punches into', () => {
      const existing = makeClip({ startTime: 1, samples: 200 }); // 1-3s
      const newClip = makeClip({ startTime: 0, samples: 150 }); // 0-1.5s, punches into existing's head
      const result = insertClipNonOverlapping([existing], newClip);
      expect(result).toHaveLength(2);
      const trimmedExisting = result.find(c => c.id === existing.id);
      expect(trimmedExisting.startTime).toBeCloseTo(1.5); // pushed forward to end of newClip
      expect(clipDuration(trimmedExisting)).toBeCloseTo(1.5); // 3 - 1.5
    });

    it('splits an existing clip in two when the new one punches a hole in the middle', () => {
      const existing = makeClip({ startTime: 0, samples: 400 }); // 0-4s
      const newClip = makeClip({ startTime: 1, samples: 100 }); // 1-2s, hole in the middle
      const result = insertClipNonOverlapping([existing], newClip);
      expect(result).toHaveLength(3); // before-remnant, after-remnant, new clip

      const before = result.find(c => c.startTime === 0);
      const after = result.find(c => c.startTime > 2 - 1e-6 && c.startTime < 2 + 1e-6);
      expect(before).toBeTruthy();
      expect(clipDuration(before)).toBeCloseTo(1); // 0-1s
      expect(after).toBeTruthy();
      expect(clipDuration(after)).toBeCloseTo(2); // 2-4s

      // Nothing overlaps: before ends where newClip starts, after starts where newClip ends.
      expect(before.startTime + clipDuration(before)).toBeCloseTo(newClip.startTime);
      expect(after.startTime).toBeCloseTo(newClip.startTime + clipDuration(newClip));
    });

    it('drops an existing clip entirely covered by the new one', () => {
      const existing = makeClip({ startTime: 1, samples: 50 }); // 1-1.5s
      const newClip = makeClip({ startTime: 0, samples: 300 }); // 0-3s, fully covers existing
      const result = insertClipNonOverlapping([existing], newClip);
      expect(result).toEqual([newClip]);
    });

    it('never produces two clips that overlap, across a mixed set of existing clips', () => {
      const a = makeClip({ startTime: 0, samples: 200 }); // 0-2s
      const b = makeClip({ startTime: 3, samples: 200 }); // 3-5s
      const c = makeClip({ startTime: 6, samples: 100 }); // 6-7s (untouched, far away)
      const newClip = makeClip({ startTime: 1, samples: 300 }); // 1-4s, spans across a's tail and b's head
      const result = insertClipNonOverlapping([a, b, c], newClip);

      const sorted = [...result].sort((x, y) => x.startTime - y.startTime);
      for (let i = 0; i < sorted.length - 1; i++) {
        const end = sorted[i].startTime + clipDuration(sorted[i]);
        expect(end).toBeLessThanOrEqual(sorted[i + 1].startTime + 1e-6);
      }
    });
  });
});
