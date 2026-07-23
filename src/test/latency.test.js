import { describe, it, expect } from 'vitest';
import {
  measureLatencies,
  compensationSeconds,
  headSkipSamples,
  detectOnsets,
  estimateLatencyFromOnsets,
  measuredLatencyToTrimMs,
} from '../audio/latency';

describe('measureLatencies', () => {
  it('reads base/output from ctx and input from the mic track', () => {
    const ctx = { baseLatency: 0.005, outputLatency: 0.02 };
    const track = { getSettings: () => ({ latency: 0.01 }) };
    expect(measureLatencies(ctx, track)).toEqual({ base: 0.005, output: 0.02, input: 0.01 });
  });

  it('falls back to output latency when the input track reports zero', () => {
    const ctx = { baseLatency: 0.005, outputLatency: 0.02 };
    const track = { getSettings: () => ({ latency: 0 }) };
    expect(measureLatencies(ctx, track).input).toBe(0.02);
  });

  it('tolerates a missing track and missing ctx fields', () => {
    expect(measureLatencies({}, null)).toEqual({ base: 0, output: 0, input: 0 });
  });
});

describe('compensationSeconds', () => {
  const lat = { base: 0.003, output: 0.02, input: 0.01 };

  it('includes input latency for a mic source', () => {
    // input + base + output = 0.033
    expect(compensationSeconds(lat, 'mic')).toBeCloseTo(0.033, 6);
  });

  it('excludes input latency for a piano source', () => {
    // base + output = 0.023 (no ADC path)
    expect(compensationSeconds(lat, 'piano')).toBeCloseTo(0.023, 6);
  });

  it('treats "both" as mic-dominant (full round trip)', () => {
    expect(compensationSeconds(lat, 'both')).toBeCloseTo(0.033, 6);
  });

  it('adds the user trim in milliseconds', () => {
    expect(compensationSeconds(lat, 'mic', 10)).toBeCloseTo(0.043, 6);
    expect(compensationSeconds(lat, 'piano', -5)).toBeCloseTo(0.018, 6);
  });
});

describe('headSkipSamples', () => {
  it('combines the capture-start offset with the compensation', () => {
    // Worklet started 0.15s before the downbeat; compensate another 0.03s.
    const skip = headSkipSamples({
      transportStartTime: 1.15,
      recordStartFrame: 48000, // 1.0s at 48k
      sampleRate: 48000,
      compensationSec: 0.03,
    });
    // (1.15 - 1.0 + 0.03) * 48000 = 0.18 * 48000 = 8640
    expect(skip).toBe(8640);
  });

  it('never returns a negative skip', () => {
    const skip = headSkipSamples({
      transportStartTime: 1.0,
      recordStartFrame: 96000, // capture started AFTER the downbeat (pathological)
      sampleRate: 48000,
      compensationSec: 0,
    });
    expect(skip).toBe(0);
  });
});

describe('detectOnsets', () => {
  it('finds transient clicks separated by a refractory gap', () => {
    const sr = 48000;
    const pcm = new Float32Array(sr); // 1 second of silence
    // Place three short bursts at 0.1s, 0.4s, 0.7s
    const clickTimes = [0.1, 0.4, 0.7];
    for (const t of clickTimes) {
      const start = Math.round(t * sr);
      for (let i = 0; i < 200; i++) pcm[start + i] = Math.sin(i * 0.5) * 0.9;
    }
    const onsets = detectOnsets(pcm, sr);
    expect(onsets.length).toBe(3);
    // Each detected onset should be within ~5ms of the true burst start.
    clickTimes.forEach((t, idx) => {
      expect(Math.abs(onsets[idx] - t)).toBeLessThan(0.006);
    });
  });

  it('returns nothing for pure silence', () => {
    expect(detectOnsets(new Float32Array(1000), 48000)).toEqual([]);
  });
});

describe('estimateLatencyFromOnsets', () => {
  it('estimates the median delay between scheduled clicks and detected onsets', () => {
    const scheduled = [0.1, 0.4, 0.7, 1.0];
    const latency = 0.025;
    const detected = scheduled.map((t) => t + latency);
    const est = estimateLatencyFromOnsets(detected, scheduled);
    expect(est).toBeCloseTo(0.025, 4);
  });

  it('ignores onsets that are implausibly far from any click', () => {
    const scheduled = [0.1, 0.4, 0.7, 1.0];
    const detected = [0.12, 0.42, 0.72, 1.02, 5.0]; // 5.0 is spurious
    const est = estimateLatencyFromOnsets(detected, scheduled);
    expect(est).toBeCloseTo(0.02, 3);
  });

  it('returns null when too few clicks match', () => {
    expect(estimateLatencyFromOnsets([0.11], [0.1, 0.4, 0.7, 1.0])).toBeNull();
  });
});

describe('measuredLatencyToTrimMs', () => {
  it('returns the residual beyond the reported latencies, in ms', () => {
    const lat = { base: 0.003, output: 0.02, input: 0.01 }; // reported = 33ms
    // Measured 45ms round trip → residual trim = 12ms.
    expect(measuredLatencyToTrimMs(0.045, lat)).toBe(12);
  });

  it('clamps to the slider range', () => {
    const lat = { base: 0, output: 0, input: 0 };
    expect(measuredLatencyToTrimMs(0.5, lat)).toBe(40); // clamp high
    expect(measuredLatencyToTrimMs(-0.5, lat)).toBe(-10); // clamp low
  });
});
