import { useEffect, useRef, useState } from 'react';
import styles from './LatencyTrimHelper.module.css';
import { getSharedAudioContext } from '../../utils/audioContext';
import { setStoredLatencyTrimMs, markLatencyTrimHelperSeen } from '../../utils/latencyTrimSettings';
import {
  LOW_LATENCY_MIC_CONSTRAINTS,
  RECORD_PREROLL_SEC,
  ensureRecorderLoaded,
  createRecorder,
  RECORDER_MIC_INPUT,
  measureLatencies,
} from '../../audio/recorderEngine';
import {
  compensationSeconds,
  headSkipSamples,
  detectOnsets,
  estimateLatencyFromOnsets,
  measuredLatencyToTrimMs,
} from '../../audio/latency';

const BPM = 80;
const BEAT_DUR = 60 / BPM;
const BEATS = 8;
const TAIL_SEC = 0.5;

/** Schedule a fixed click track from startTime; returns the scheduled ctx times + the
 *  beat-highlight timeouts. */
function scheduleClickTrack(ctx, startTime, destination, onBeat) {
  const clickTimes = [];
  const timeouts = [];
  for (let i = 0; i < BEATS; i++) {
    const t = startTime + i * BEAT_DUR;
    clickTimes.push(t);
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
  return { clickTimes, timeouts };
}

export default function LatencyTrimHelper({ initialTrimMs, onSave, onClose }) {
  const [phase, setPhase] = useState('intro'); // intro | recording | recorded | playing
  const [beatIndex, setBeatIndex] = useState(-1);
  const [trimMs, setTrimMs] = useState(initialTrimMs);
  const [hasRecording, setHasRecording] = useState(false);
  const [micError, setMicError] = useState(false);
  const [autoResult, setAutoResult] = useState(null); // { measuredMs, appliedMs } | { failed: true }

  const recorderRef = useRef(null);
  const sinkRef = useRef(null);
  const micStreamRef = useRef(null);
  const timeoutsRef = useRef([]);
  // Captured take: raw mic PCM + the frame it began + the click schedule + latencies.
  const takeRef = useRef(null);

  const clearScheduled = () => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  };

  const teardown = () => {
    clearScheduled();
    try { if (recorderRef.current) recorderRef.current.node.disconnect(); } catch { /* noop */ }
    recorderRef.current = null;
    try { if (sinkRef.current) sinkRef.current.disconnect(); } catch { /* noop */ }
    sinkRef.current = null;
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
  };

  useEffect(() => teardown, []);

  const handleRecord = async () => {
    clearScheduled();
    setMicError(false);
    setAutoResult(null);
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(LOW_LATENCY_MIC_CONSTRAINTS);
    } catch {
      setMicError(true);
      return;
    }
    micStreamRef.current = stream;
    const micTrack = stream.getAudioTracks()[0] || null;
    const latencies = measureLatencies(ctx, micTrack);

    try {
      await ensureRecorderLoaded(ctx);
    } catch (err) {
      console.error('Failed to load recorder worklet:', err);
      setMicError(true);
      teardown();
      return;
    }

    const recorder = createRecorder(ctx);
    recorderRef.current = recorder;

    // Silent sink keeps the recorder worklet pulled continuously.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    recorder.node.connect(sink);
    sink.connect(ctx.destination);
    sinkRef.current = sink;

    const micSource = ctx.createMediaStreamSource(stream);
    micSource.connect(recorder.node, 0, RECORDER_MIC_INPUT);

    // Audible click through the speakers.
    const clickGain = ctx.createGain();
    clickGain.gain.value = 0.6;
    clickGain.connect(ctx.destination);

    const startTime = ctx.currentTime + RECORD_PREROLL_SEC;
    setPhase('recording');
    setBeatIndex(-1);
    const { clickTimes, timeouts } = scheduleClickTrack(ctx, startTime, clickGain, setBeatIndex);
    timeoutsRef.current = timeouts;

    const stopDelayMs = (startTime - ctx.currentTime) * 1000 + (BEATS * BEAT_DUR + TAIL_SEC) * 1000;
    timeoutsRef.current.push(setTimeout(async () => {
      let result = null;
      try {
        result = await recorder.stop();
      } catch (e) {
        console.error('Recorder flush failed:', e);
      }
      teardown();
      if (result && result.samples > 0) {
        takeRef.current = {
          micPcm: result.micPcm,
          startFrame: result.startFrame,
          sampleRate: result.sampleRate,
          transportStartTime: startTime,
          clickTimes,
          latencies,
        };
        setHasRecording(true);
      }
      setPhase('recorded');
      setBeatIndex(-1);
    }, stopDelayMs));
  };

  const handlePlayback = () => {
    const take = takeRef.current;
    if (!take) return;
    clearScheduled();

    const ctx = getSharedAudioContext();
    const compensationSec = compensationSeconds(take.latencies, 'mic', trimMs);
    const skip = headSkipSamples({
      transportStartTime: take.transportStartTime,
      recordStartFrame: take.startFrame,
      sampleRate: take.sampleRate,
      compensationSec,
    });
    const safeSkip = Math.min(skip, Math.max(0, take.micPcm.length - 1));
    const aligned = take.micPcm.subarray(safeSkip);

    const buffer = ctx.createBuffer(1, Math.max(1, aligned.length), take.sampleRate);
    buffer.getChannelData(0).set(aligned);

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
    const { timeouts } = scheduleClickTrack(ctx, startTime, clickGain, setBeatIndex);
    timeoutsRef.current = timeouts;

    const totalMs = (startTime - ctx.currentTime) * 1000 + (BEATS * BEAT_DUR + TAIL_SEC) * 1000;
    timeoutsRef.current.push(setTimeout(() => { setPhase('recorded'); setBeatIndex(-1); }, totalMs));
  };

  // Objective calibration: find the recorded click-bleed onsets and compare them to
  // when the clicks were scheduled to measure the real round-trip latency.
  const handleAutoDetect = () => {
    const take = takeRef.current;
    if (!take) return;
    const recordStartSec = take.startFrame / take.sampleRate;
    const scheduledRel = take.clickTimes.map((t) => t - recordStartSec);
    const onsets = detectOnsets(take.micPcm, take.sampleRate);
    const measured = estimateLatencyFromOnsets(onsets, scheduledRel);
    if (measured === null) {
      setAutoResult({ failed: true });
      return;
    }
    const applied = measuredLatencyToTrimMs(measured, take.latencies);
    setTrimMs(applied);
    setAutoResult({ measuredMs: Math.round(measured * 1000), appliedMs: applied });
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
            <div className={styles.trimHintTip}>
              💡 On <strong>speakers</strong> (not headphones)? Use <strong>Auto-detect</strong> to measure it exactly.
            </div>
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
            {phase === 'intro' && ' '}
          </div>

          {micError && (
            <div className={styles.errorText}>Microphone access is required to calibrate latency.</div>
          )}

          {autoResult && autoResult.failed && (
            <div className={styles.errorText}>
              Couldn&rsquo;t detect the click in your recording. Use speakers (not headphones) and record again, or calibrate by ear.
            </div>
          )}
          {autoResult && !autoResult.failed && (
            <div className={styles.autoResult}>
              ✅ Measured round-trip ≈ {autoResult.measuredMs}ms → Trim set to {autoResult.appliedMs}ms.
            </div>
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
            <button className={styles.autoBtn} onClick={handleAutoDetect} disabled={!hasRecording || busy} id="latency-helper-auto-btn" title="Measure latency from the recorded click (use speakers)">
              🎯 Auto-detect
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
