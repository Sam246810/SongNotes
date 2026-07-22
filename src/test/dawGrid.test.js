import { describe, it, expect } from 'vitest';

/**
 * Helper function replicating DAW Grid Math formulas
 */
function calculateGridMath(bpm, beatsPerMeasure, pixelsPerBeat = 40) {
  const pixelsPerMeasure = pixelsPerBeat * beatsPerMeasure;
  const secondsPerBeat = 60 / bpm;
  const secondsPerMeasure = secondsPerBeat * beatsPerMeasure;
  const pixelsPerSecond = (pixelsPerBeat * bpm) / 60;
  return { pixelsPerMeasure, secondsPerBeat, secondsPerMeasure, pixelsPerSecond };
}

describe('DAW Timeline Grid Mathematics', () => {
  it('calculates measure pixel width accurately based on time signature', () => {
    // 2/4 time signature -> 2 beats * 40px = 80px per measure
    expect(calculateGridMath(120, 2).pixelsPerMeasure).toBe(80);
    // 3/4 time signature -> 3 beats * 40px = 120px per measure
    expect(calculateGridMath(120, 3).pixelsPerMeasure).toBe(120);
    // 4/4 time signature -> 4 beats * 40px = 160px per measure
    expect(calculateGridMath(120, 4).pixelsPerMeasure).toBe(160);
    // 6/8 time signature -> 6 beats * 40px = 240px per measure
    expect(calculateGridMath(120, 6).pixelsPerMeasure).toBe(240);
  });

  it('scales pixels per second directly with BPM tempo', () => {
    // 60 BPM -> 1 beat (40px) per second = 40px/sec
    expect(calculateGridMath(60, 4).pixelsPerSecond).toBe(40);
    // 120 BPM -> 2 beats (80px) per second = 80px/sec
    expect(calculateGridMath(120, 4).pixelsPerSecond).toBe(80);
    // 180 BPM -> 3 beats (120px) per second = 120px/sec
    expect(calculateGridMath(180, 4).pixelsPerSecond).toBe(120);
    // 240 BPM -> 4 beats (160px) per second = 160px/sec
    expect(calculateGridMath(240, 4).pixelsPerSecond).toBe(160);
  });

  it('places the playhead precisely on measure boundaries at exact measure times', () => {
    const { secondsPerMeasure, pixelsPerSecond, pixelsPerMeasure } = calculateGridMath(120, 4);
    // At 120 BPM in 4/4, 1 measure is 2.0 seconds (160px)
    expect(secondsPerMeasure).toBe(2.0);

    // Playhead at 2.0 seconds should land exactly at Bar 2 (160px)
    const playheadXAtBar2 = 2.0 * pixelsPerSecond;
    expect(playheadXAtBar2).toBe(pixelsPerMeasure);

    // Playhead at 4.0 seconds should land exactly at Bar 3 (320px)
    const playheadXAtBar3 = 4.0 * pixelsPerSecond;
    expect(playheadXAtBar3).toBe(pixelsPerMeasure * 2);
  });

  it('correctly calculates recorded audio clip pixel width for any tempo', () => {
    const durationInSeconds = 3.0; // 3-second recording
    const { pixelsPerSecond: ppsAt120 } = calculateGridMath(120, 4);
    const { pixelsPerSecond: ppsAt240 } = calculateGridMath(240, 4);

    // At 120 BPM, 3 seconds = 240px (1.5 measures of 4/4)
    expect(durationInSeconds * ppsAt120).toBe(240);

    // At 240 BPM (twice as fast), 3 seconds = 480px (3 measures of 4/4)
    expect(durationInSeconds * ppsAt240).toBe(480);
  });

  it('detects and trims leading encoder silence from audio buffer channel data', () => {
    // Simulate audio buffer channel data with 100ms silent samples followed by audio signal
    const sampleRate = 44100;
    const silentSamplesCount = 4410; // 100ms of initial MediaRecorder / Opus silence
    const totalSamples = 44100;
    const data = new Float32Array(totalSamples);
    
    // Signal starts after silence
    for (let i = silentSamplesCount; i < totalSamples; i++) {
      data[i] = Math.sin(i * 0.1) * 0.5;
    }

    let firstSample = 0;
    const threshold = 0.004;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > threshold) {
        firstSample = i;
        break;
      }
    }

    expect(firstSample).toBe(silentSamplesCount);
    const leadingSilenceMs = (firstSample / sampleRate) * 1000;
    expect(leadingSilenceMs).toBeCloseTo(100, 1);
  });
});
