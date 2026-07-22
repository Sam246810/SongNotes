import {
  LOW_LATENCY_MIC_CONSTRAINTS,
  measureLatencies,
  compensationSeconds,
  headSkipSamples,
} from './latency';

/**
 * Shared low-latency recording engine.
 *
 * A single AudioWorklet processor captures TWO independent inputs — mic (input 0)
 * and piano (input 1) — into separate Wasm-memory ring buffers on the audio thread,
 * with zero postMessage traffic during recording. On stop it bulk-transfers both
 * buffers plus the exact `currentFrame` at which capture began, so the main thread
 * can position the take on the timeline with sample accuracy (Soundtrap "problem 2b").
 *
 * This module is the single source of truth for recording; DAWPanel and the latency
 * calibration helper both use it.
 */

/** Pre-roll (seconds) before the transport downbeat. Guarantees the worklet is
 *  already capturing before T0, so head-alignment is always a positive trim, never a
 *  missing-head pad. */
export const RECORD_PREROLL_SEC = 0.15;

// --- AudioWorklet processor source (runs on the audio render thread) ---
const recorderWorkletCode = `
class DualPCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    // 256 Wasm pages = 16MB = ~87s of mono float32 @48kHz, per input.
    this.micMem = new WebAssembly.Memory({ initial: 256 });
    this.pianoMem = new WebAssembly.Memory({ initial: 256 });
    this.mic = new Float32Array(this.micMem.buffer);
    this.piano = new Float32Array(this.pianoMem.buffer);
    this.pos = 0;
    this.startFrame = -1;
    this.active = true;

    this.port.onmessage = (msg) => {
      if (msg.data === 'flush') {
        const n = this.pos;
        if (n > 0) {
          const micOut = new Float32Array(n);
          micOut.set(this.mic.subarray(0, n));
          const pianoOut = new Float32Array(n);
          pianoOut.set(this.piano.subarray(0, n));
          this.port.postMessage(
            {
              type: 'pcm',
              mic: micOut.buffer,
              piano: pianoOut.buffer,
              samples: n,
              startFrame: this.startFrame,
              sampleRate,
            },
            [micOut.buffer, pianoOut.buffer]
          );
        } else {
          this.port.postMessage({ type: 'pcm', mic: null, piano: null, samples: 0, startFrame: -1, sampleRate });
        }
        this.pos = 0;
        this.active = false;
        this.startFrame = -1;
      }
    };
  }

  process(inputs) {
    if (!this.active) return true;
    if (this.startFrame < 0) this.startFrame = currentFrame;

    const micIn = inputs[0] && inputs[0][0];
    const pianoIn = inputs[1] && inputs[1][0];
    const len = (micIn && micIn.length) || (pianoIn && pianoIn.length) || 128;

    if (this.pos + len <= this.mic.length) {
      if (micIn) this.mic.set(micIn, this.pos);
      if (pianoIn) this.piano.set(pianoIn, this.pos);
      // Advance the shared write head even if only one input is connected, so the
      // two ring buffers stay sample-aligned to each other.
      this.pos += len;
    }
    return true;
  }
}
registerProcessor('dual-pcm-recorder', DualPCMRecorder);
`;

let _workletLoaded = false;

/** Load the recorder worklet module once per context lifetime. */
export async function ensureRecorderLoaded(ctx) {
  if (_workletLoaded) return;
  const blob = new Blob([recorderWorkletCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
    _workletLoaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Create the dual-input recorder node. Connect mic to input 0, piano to input 1.
 *
 * The node is given a single (silent) output. The processor never writes to it, so it
 * emits silence, but routing that output to the destination guarantees the browser
 * keeps pulling the node's process() continuously — even when the only input is the
 * intermittent piano bus. Callers should connect node -> a zero-gain -> destination.
 */
export function createRecorderNode(ctx) {
  return new AudioWorkletNode(ctx, 'dual-pcm-recorder', {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
  });
}

export const RECORDER_MIC_INPUT = 0;
export const RECORDER_PIANO_INPUT = 1;

/**
 * Build the final, timeline-aligned AudioBuffer for a take.
 *
 * Applies per-source round-trip compensation: the mic and piano ring buffers share a
 * start frame but are trimmed by different amounts (mic includes ADC input latency,
 * piano does not), then combined according to the track's input type.
 *
 * @param {object} p
 * @param {AudioContext} p.ctx
 * @param {Float32Array|null} p.micPcm
 * @param {Float32Array|null} p.pianoPcm
 * @param {number} p.startFrame
 * @param {number} p.sampleRate
 * @param {number} p.transportStartTime  ctx time of the transport downbeat
 * @param {{base:number,output:number,input:number}} p.latencies
 * @param {number} p.userTrimMs    extra trim for mic takes (ms)
 * @param {number} [p.pianoTrimMs] extra trim for piano takes (ms); defaults to userTrimMs
 * @param {'mic'|'piano'|'both'} p.inputType
 * @returns {AudioBuffer|null}
 */
export function buildTrackBuffer({
  ctx,
  micPcm,
  pianoPcm,
  startFrame,
  sampleRate,
  transportStartTime,
  latencies,
  userTrimMs,
  pianoTrimMs,
  inputType,
}) {
  const sliceFor = (pcm, source) => {
    if (!pcm || pcm.length === 0) return new Float32Array(0);
    const trimMs = source === 'piano' ? (pianoTrimMs ?? userTrimMs) : userTrimMs;
    const compensationSec = compensationSeconds(latencies, source, trimMs);
    const skip = headSkipSamples({ transportStartTime, recordStartFrame: startFrame, sampleRate, compensationSec });
    // Safety: never trim more than 40% of the take (protects against a wildly wrong
    // latency figure eating a whole short recording).
    const safeSkip = Math.min(skip, Math.floor(pcm.length * 0.4));
    return pcm.subarray(safeSkip);
  };

  let out;
  if (inputType === 'piano') {
    out = sliceFor(pianoPcm, 'piano');
  } else if (inputType === 'mic') {
    out = sliceFor(micPcm, 'mic');
  } else {
    // 'both': slice each source by its own compensation, then sum.
    const micSlice = sliceFor(micPcm, 'mic');
    const pianoSlice = sliceFor(pianoPcm, 'piano');
    const len = Math.max(micSlice.length, pianoSlice.length);
    out = new Float32Array(len);
    for (let i = 0; i < micSlice.length; i++) out[i] += micSlice[i];
    for (let i = 0; i < pianoSlice.length; i++) out[i] += pianoSlice[i];
  }

  if (!out || out.length === 0) return null;
  const buffer = ctx.createBuffer(1, out.length, sampleRate);
  buffer.getChannelData(0).set(out);
  return buffer;
}

/**
 * Convenience wrapper around the worklet lifecycle for callers that just want a
 * promise of the captured PCM. Resolves with { micPcm, pianoPcm, samples, startFrame,
 * sampleRate } when stop() is called.
 */
export function createRecorder(ctx) {
  const node = createRecorderNode(ctx);
  let resolveFlush;
  const flushed = new Promise((res) => { resolveFlush = res; });

  node.port.onmessage = (e) => {
    const d = e.data;
    if (d && d.type === 'pcm') {
      resolveFlush({
        micPcm: d.mic ? new Float32Array(d.mic) : null,
        pianoPcm: d.piano ? new Float32Array(d.piano) : null,
        samples: d.samples,
        startFrame: d.startFrame,
        sampleRate: d.sampleRate,
      });
    }
  };

  return {
    node,
    /** Ask the worklet to bulk-transfer its buffers; returns the flush promise. */
    stop() {
      node.port.postMessage('flush');
      return flushed;
    },
  };
}

// Re-export the latency helpers callers commonly need alongside the engine, so a
// component can import everything recording-related from one module.
export { LOW_LATENCY_MIC_CONSTRAINTS, measureLatencies };
