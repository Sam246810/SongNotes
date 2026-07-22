import { useEffect, useRef, useState } from 'react';
import styles from './LatencyTrimHelper.module.css';
import { getSharedAudioContext } from '../../utils/audioContext';
import { setStoredLatencyTrimMs, markLatencyTrimHelperSeen } from '../../utils/latencyTrimSettings';

const BPM = 80;
const BEAT_DUR = 60 / BPM;
const BEATS = 8;

/**
 * Minimal Wasm-backed PCM capture, scoped to this component so it never
 * collides with (or has to coordinate with) DAWPanel's own recording engine.
 */
const helperWorkletCode = `
class LatencyHelperPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmMemory = new WebAssembly.Memory({ initial: 64 }); // ~21s mono @48kHz
    this.ringBuffer = new Float32Array(this.wasmMemory.buffer);
    this.writePos = 0;
    this.active = true;

    this.port.onmessage = (msg) => {
      if (msg.data === 'flush') {
        const totalSamples = this.writePos;
        if (totalSamples > 0) {
          const out = new Float32Array(totalSamples);
          out.set(this.ringBuffer.subarray(0, totalSamples));
          this.port.postMessage({ type: 'pcm-data', buffer: out.buffer, samples: totalSamples }, [out.buffer]);
        } else {
          this.port.postMessage({ type: 'pcm-data', buffer: null, samples: 0 });
        }
        this.writePos = 0;
        this.active = false;
      }
    };
  }

  process(inputs) {
    if (!this.active) return true;
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const len = ch.length;
      if (this.writePos + len <= this.ringBuffer.length) {
        this.ringBuffer.set(ch, this.writePos);
        this.writePos += len;
      }
    }
    return true;
  }
}
registerProcessor('latency-helper-pcm-processor', LatencyHelperPcmProcessor);
`;

let _helperWorkletLoaded = false;
async function ensureHelperWorkletLoaded(ctx) {
  if (_helperWorkletLoaded) return;
  const blob = new Blob([helperWorkletCode], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  _helperWorkletLoaded = true;
}

/** Schedules a fixed-length click track and returns its beat-highlight timeouts. */
function scheduleClickTrack(ctx, startTime, destination, onBeat) {
  const timeouts = [];
  for (let i = 0; i < BEATS; i++) {
    const t = startTime + i * BEAT_DUR;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    osc.frequency.setValueAtTime(i === 0 ? 1000 : 700, t);
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.start(t);
    osc.stop(t + 0.06);

    const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
    timeouts.push(setTimeout(() => onBeat(i), delayMs));
  }
  return timeouts;
}

export default function LatencyTrimHelper({ initialTrimMs, onSave, onClose }) {
  const [phase, setPhase] = useState('intro'); // intro | recording | recorded | playing
  const [beatIndex, setBeatIndex] = useState(-1);
  const [trimMs, setTrimMs] = useState(initialTrimMs);
  const [hasRecording, setHasRecording] = useState(false);
  const [micError, setMicError] = useState(false);

  const workletRef = useRef(null);
  const micStreamRef = useRef(null);
  const rawBufferRef = useRef(null); // { data: Float32Array, sampleRate }
  const micInputLatencyRef = useRef(0);
  const timeoutsRef = useRef([]);

  const clearScheduled = () => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  };

  useEffect(() => {
    return () => {
      clearScheduled();
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (workletRef.current) {
        try { workletRef.current.disconnect(); } catch (e) {}
      }
    };
  }, []);

  const finishRecording = () => {
    const worklet = workletRef.current;
    if (!worklet) return;
    worklet.port.onmessage = (e) => {
      if (e.data && e.data.type === 'pcm-data' && e.data.buffer) {
        rawBufferRef.current = {
          data: new Float32Array(e.data.buffer),
          sampleRate: getSharedAudioContext().sampleRate,
        };
        setHasRecording(true);
      }
      setPhase('recorded');
      setBeatIndex(-1);
    };
    worklet.port.postMessage('flush');

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    try { worklet.disconnect(); } catch (e) {}
    workletRef.current = null;
  };

  const handleRecord = async () => {
    clearScheduled();
    setMicError(false);
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0, channelCount: 1 },
      });
    } catch (err) {
      setMicError(true);
      return;
    }
    micStreamRef.current = stream;
    const micTrack = stream.getAudioTracks()[0];
    const trackSettings = micTrack ? micTrack.getSettings() : {};
    micInputLatencyRef.current = trackSettings.latency || ctx.outputLatency || 0;

    try {
      await ensureHelperWorkletLoaded(ctx);
      const workletNode = new AudioWorkletNode(ctx, 'latency-helper-pcm-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      workletRef.current = workletNode;

      const micSource = ctx.createMediaStreamSource(stream);
      micSource.connect(workletNode);

      const clickGain = ctx.createGain();
      clickGain.gain.value = 0.6;
      clickGain.connect(ctx.destination);

      const startTime = ctx.currentTime + 0.15;
      setPhase('recording');
      setBeatIndex(-1);
      timeoutsRef.current = scheduleClickTrack(ctx, startTime, clickGain, setBeatIndex);

      const stopDelayMs = (startTime - ctx.currentTime) * 1000 + (BEATS * BEAT_DUR + 0.5) * 1000;
      timeoutsRef.current.push(setTimeout(finishRecording, stopDelayMs));
    } catch (err) {
      console.error('Failed to start latency calibration recording:', err);
      setMicError(true);
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
    }
  };

  const handlePlayback = () => {
    const raw = rawBufferRef.current;
    if (!raw) return;
    clearScheduled();

    const ctx = getSharedAudioContext();
    const rtLatencySec = micInputLatencyRef.current + (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + trimMs / 1000;
    const compSamples = Math.max(0, Math.min(Math.round(rtLatencySec * raw.sampleRate), raw.data.length - 1));
    const finalLength = raw.data.length - compSamples;

    const buffer = ctx.createBuffer(1, Math.max(1, finalLength), raw.sampleRate);
    buffer.getChannelData(0).set(raw.data.subarray(compSamples));

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = 1;
    voiceGain.connect(ctx.destination);

    const clickGain = ctx.createGain();
    clickGain.gain.value = 0.6;
    clickGain.connect(ctx.destination);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(voiceGain);

    const startTime = ctx.currentTime + 0.15;
    source.start(startTime);

    setPhase('playing');
    setBeatIndex(-1);
    timeoutsRef.current = scheduleClickTrack(ctx, startTime, clickGain, setBeatIndex);

    const totalMs = (startTime - ctx.currentTime) * 1000 + (BEATS * BEAT_DUR + 0.5) * 1000;
    timeoutsRef.current.push(setTimeout(() => { setPhase('recorded'); setBeatIndex(-1); }, totalMs));
  };

  const handleSave = () => {
    setStoredLatencyTrimMs(trimMs);
    markLatencyTrimHelperSeen();
    onSave(trimMs);
  };

  const handleSkip = () => {
    markLatencyTrimHelperSeen();
    onClose();
  };

  const busy = phase === 'recording' || phase === 'playing';

  return (
    <div className={styles.modalOverlay} onClick={handleSkip}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>🎯 Calibrate Recording Latency</h3>
          <button className={styles.closeModalBtn} onClick={handleSkip} title="Skip for now" id="latency-helper-skip-btn">✕</button>
        </div>

        <div className={styles.modalBody}>
          <p className={styles.introText}>
            Your mic and speakers add a small delay that can throw recordings out of sync.
            Let's fix that once — it applies to every song from now on, not just this one.
          </p>
          <ol className={styles.stepsList}>
            <li>Click <strong>Record</strong> — a click plays at 80 BPM.</li>
            <li>Say <strong>&ldquo;Do&rdquo;</strong> right on each of the {BEATS} clicks.</li>
            <li>Click <strong>Play Back</strong> — you should hear your own &ldquo;Do&rdquo; landing right on the click.</li>
            <li>If it sounds early or late, nudge the <strong>Trim</strong> slider and play back again.</li>
          </ol>

          <div className={styles.trimHint}>
            <div>⬆️ &ldquo;Do&rdquo; lands <strong>after</strong> the click (late) → <strong>increase</strong> Trim.</div>
            <div>⬇️ &ldquo;Do&rdquo; lands <strong>before</strong> the click (early) → <strong>decrease</strong> Trim.</div>
          </div>

          <div className={styles.beatRow}>
            {Array.from({ length: BEATS }).map((_, i) => (
              <span key={i} className={`${styles.beatDot} ${i === beatIndex ? styles.beatDotActive : ''}`} />
            ))}
          </div>

          <div className={styles.statusText}>
            {phase === 'recording' && `🔴 Say "Do" on the click… (${Math.max(1, beatIndex + 1)}/${BEATS})`}
            {phase === 'playing' && '▶ Listening — does "Do" land on the click?'}
            {phase === 'recorded' && 'Recorded! Play it back, or record again.'}
            {phase === 'intro' && ' '}
          </div>

          {micError && (
            <div className={styles.errorText}>Microphone access is required to calibrate latency.</div>
          )}

          <div className={styles.trimRow}>
            <span className={styles.trimLabel}>Trim</span>
            <input
              type="range"
              min="-10" max="40" step="1"
              value={trimMs}
              onChange={(e) => setTrimMs(parseInt(e.target.value, 10))}
              className={styles.trimSlider}
              title={`Latency trim: ${trimMs}ms`}
            />
            <span className={styles.trimValue}>{trimMs}ms</span>
          </div>

          <div className={styles.actionsRow}>
            <button className={styles.recordBtn} onClick={handleRecord} disabled={busy} id="latency-helper-record-btn">
              ● {hasRecording ? 'Record Again' : 'Record'}
            </button>
            <button className={styles.playBtn} onClick={handlePlayback} disabled={!hasRecording || busy} id="latency-helper-playback-btn">
              ▶ Play Back
            </button>
          </div>

          <div className={styles.footerRow}>
            <button className={styles.skipBtn} onClick={handleSkip} id="latency-helper-skip-footer-btn">
              Skip for now
            </button>
            <button className={styles.saveBtn} onClick={handleSave} disabled={!hasRecording} id="latency-helper-save-btn">
              ✅ Sounds Right — Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
