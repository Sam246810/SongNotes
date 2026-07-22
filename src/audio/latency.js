/**
 * Pure latency math for the recording engine.
 *
 * These functions are deliberately free of any Web Audio / DOM dependency so the
 * alignment logic — the part that historically got recordings out of sync — can be
 * unit-tested deterministically without a microphone or an AudioContext.
 *
 * Model (see Soundtrap's W3C "audio latency in browser-based DAWs" talk):
 *   - The metronome click for the downbeat is *scheduled* at context time T0 but is
 *     physically heard OUTPUT_LATENCY later.
 *   - The performer reacts to what they hear, so their sound happens at ~T0 + output.
 *   - A MIC captures that sound INPUT_LATENCY later (ADC + driver + OS + plumbing).
 *   - A PIANO note is synthesised inside the context, so it has NO input latency —
 *     it lands on the bus at the moment of the (heard-reaction) keypress.
 *
 * Therefore, to make a take line up with the grid we must discard, from the head of
 * the recording, both (a) the gap between where the worklet actually started
 * capturing and the transport downbeat, and (b) the round-trip latency for that
 * source. Everything below computes those quantities.
 */

/** getUserMedia constraints tuned for lowest possible input latency. */
export const LOW_LATENCY_MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    latency: 0,
    channelCount: 1,
  },
};

/**
 * Read the live latency figures from the running context and mic track.
 * All values are in SECONDS.
 *
 * @param {AudioContext} ctx
 * @param {MediaStreamTrack|null} micTrack
 * @returns {{ base: number, output: number, input: number }}
 */
export function measureLatencies(ctx, micTrack) {
  const base = (ctx && ctx.baseLatency) || 0;
  const output = (ctx && ctx.outputLatency) || 0;
  let input = 0;
  if (micTrack && typeof micTrack.getSettings === 'function') {
    const settings = micTrack.getSettings() || {};
    input = settings.latency || 0;
  }
  // Chrome frequently reports latency:0 for the input track. Input and output
  // hardware paths are near-symmetric on most sound cards, so fall back to the
  // output figure rather than assuming zero input latency.
  if (!input) input = output;
  return { base, output, input };
}

/**
 * Round-trip compensation (SECONDS) to remove from the head of a take, for a source.
 *
 * @param {{ base: number, output: number, input: number }} latencies
 * @param {'mic'|'piano'|'both'} source
 * @param {number} userTrimMs  residual manual/calibrated trim, in milliseconds
 */
export function compensationSeconds(latencies, source, userTrimMs = 0) {
  const { base = 0, output = 0, input = 0 } = latencies || {};
  const trim = (userTrimMs || 0) / 1000;
  if (source === 'piano') {
    // Synthesised in-context: only the output path (what the player reacted to)
    // plus internal processing delays it relative to the grid.
    return base + output + trim;
  }
  // 'mic' and 'both' are mic-dominant: full round trip.
  return input + base + output + trim;
}

/**
 * Number of samples to skip from the head of a recorded buffer so that the sample
 * which was captured at the transport downbeat (T0), shifted earlier by the round-trip
 * latency, becomes sample 0 of the stored take. Always >= 0 given a proper pre-roll.
 *
 * @param {object} p
 * @param {number} p.transportStartTime  ctx time of the transport downbeat (s)
 * @param {number} p.recordStartFrame    global frame index of the worklet's first sample
 * @param {number} p.sampleRate
 * @param {number} p.compensationSec      from compensationSeconds()
 */
export function headSkipSamples({ transportStartTime, recordStartFrame, sampleRate, compensationSec }) {
  const recordStartTime = recordStartFrame / sampleRate;
  const startOffsetSec = transportStartTime - recordStartTime; // > 0 when capture began before T0
  const totalSec = startOffsetSec + compensationSec;
  return Math.max(0, Math.round(totalSec * sampleRate));
}

/**
 * Detect transient onset sample indices in a mono PCM buffer using a short-window
 * energy follower with a refractory gap. Used to acoustically measure round-trip
 * latency from the metronome-click bleed captured by the mic.
 *
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {object} [opts]
 * @param {number} [opts.minGapSec=0.15]     refractory period between onsets
 * @param {number} [opts.thresholdRatio=0.35] fraction of peak energy that counts as an onset
 * @param {number} [opts.windowSec=0.003]    energy window length
 * @returns {number[]} onset times in seconds
 */
export function detectOnsets(pcm, sampleRate, opts = {}) {
  const { minGapSec = 0.15, thresholdRatio = 0.35, windowSec = 0.003 } = opts;
  if (!pcm || pcm.length === 0) return [];

  const win = Math.max(1, Math.round(windowSec * sampleRate));
  const minGap = Math.max(1, Math.round(minGapSec * sampleRate));

  // Short-window RMS energy envelope.
  const env = new Float32Array(pcm.length);
  let acc = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    acc += v * v;
    if (i >= win) {
      const old = pcm[i - win];
      acc -= old * old;
    }
    env[i] = Math.sqrt(acc / win);
  }

  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
  if (peak <= 0) return [];

  const threshold = peak * thresholdRatio;
  const onsets = [];
  let lastOnset = -Infinity;
  for (let i = 0; i < env.length; i++) {
    if (env[i] >= threshold && i - lastOnset >= minGap) {
      onsets.push(i / sampleRate);
      lastOnset = i;
    }
  }
  return onsets;
}

/**
 * Given detected onset times and the times the clicks were scheduled (both in the
 * recording's own timebase, seconds), estimate the measured round-trip latency as the
 * median of (nearest onset at-or-after each scheduled click − scheduled click).
 * Returns null if too few clicks could be matched.
 *
 * @param {number[]} detectedTimes
 * @param {number[]} scheduledTimes
 * @param {number} [maxMatchSec=0.25] largest plausible round-trip to accept
 * @returns {number|null} seconds
 */
export function estimateLatencyFromOnsets(detectedTimes, scheduledTimes, maxMatchSec = 0.25) {
  if (!detectedTimes || !scheduledTimes || detectedTimes.length === 0) return null;
  const deltas = [];
  for (const scheduled of scheduledTimes) {
    let best = null;
    for (const onset of detectedTimes) {
      const d = onset - scheduled;
      if (d >= -0.005 && d <= maxMatchSec) {
        if (best === null || d < best) best = d;
      }
    }
    if (best !== null) deltas.push(Math.max(0, best));
  }
  if (deltas.length < Math.max(2, Math.ceil(scheduledTimes.length / 2))) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
}

/**
 * Convert a measured round-trip latency into the residual "user trim" (ms) that the
 * engine stores, i.e. the part NOT already accounted for by the browser-reported
 * input/base/output figures. Clamped to the UI slider range.
 *
 * @param {number} measuredRoundTripSec
 * @param {{ base: number, output: number, input: number }} latencies
 * @param {number} [min=-10]
 * @param {number} [max=40]
 * @returns {number} milliseconds, rounded
 */
export function measuredLatencyToTrimMs(measuredRoundTripSec, latencies, min = -10, max = 40) {
  const { base = 0, output = 0, input = 0 } = latencies || {};
  const reportedSec = input + base + output;
  const residualMs = Math.round((measuredRoundTripSec - reportedSec) * 1000);
  return Math.max(min, Math.min(max, residualMs));
}
