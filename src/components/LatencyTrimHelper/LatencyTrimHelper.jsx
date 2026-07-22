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
} from '../../audio/latency';

const BPM = 80;
const BEAT_DUR = 60 / BPM;
const BEATS = 8;
const COUNT_IN = 4; // preparatory beats before the "say Do" beats
const TOTAL_BEATS = COUNT_IN + BEATS;
const TAIL_SEC = 0.5;

/**
 * Schedule a click track: COUNT_IN softer preparatory beats, then BEATS accented
 * recording beats. onBeat(i) fires per beat with the raw index (0..TOTAL_BEATS-1).
 * Returns the recording-beat ctx times + the beat-highlight timeouts.
 */
function scheduleClickTrack(ctx, startTime, destination, onBeat) {
  const recordClickTimes = [];
  const timeouts = [];
  for (let i = 0; i < TOTAL_BEATS; i++) {
    const t = startTime + i * BEAT_DUR;
    const isCountIn = i < COUNT_IN;
    const recBeat = i - COUNT_IN; // 0..BEATS-1 once recording starts
    if (!isCountIn) recordClickTimes.push(t);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    osc.frequency.setValueAtTime(isCountIn ? 500 : (recBeat === 0 ? 1000 : 700), t);
    gain.gain.setValueAtTime(isCountIn ? 0.3 : 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.start(t);
    osc.stop(t + 0.06);

    const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
    timeouts.push(setTimeout(() => onBeat(i), delayMs));
  }
  return { recordClickTimes, timeouts };
}

export default function LatencyTrimHelper({ initialTrimMs, onSave, onClose }) {
  const [phase, setPhase] = useState('intro'); // intro | recording | recorded | playing
  const [beatIndex, setBeatIndex] = useState(-1);
  const [countIn, setCountIn] = useState(null); // countdown number during the count-in
  const [trimMs, setTrimMs] = useState(initialTrimMs);
  const [hasRecording, setHasRecording] = useState(false);
  const [micError, setMicError] = useState(false);

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

  // Per-beat UI update: count down during the count-in, then highlight recording beats.
  const handleBeat = (i) => {
    if (i < COUNT_IN) {
      setCountIn(COUNT_IN - i);
      setBeatIndex(-1);
    } else {
      setCountIn(null);
      setBeatIndex(i - COUNT_IN);
    }
  };

  const handleRecord = async () => {
    clearScheduled();
    setMicError(false);
    setCountIn(null);
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
    const { recordClickTimes, timeouts } = scheduleClickTrack(ctx, startTime, clickGain, handleBeat);
    timeoutsRef.current = timeouts;

    const stopDelayMs = (startTime - ctx.currentTime) * 1000 + (TOTAL_BEATS * BEAT_DUR + TAIL_SEC) * 1000;
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
          clickTimes: recordClickTimes,
          latencies,
        };
        setHasRecording(true);
      }
      setPhase('recorded');
      setBeatIndex(-1);
      setCountIn(null);
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
    const { timeouts } = scheduleClickTrack(ctx, startTime, clickGain, handleBeat);
    timeoutsRef.current = timeouts;

    const totalMs = (startTime - ctx.currentTime) * 1000 + (TOTAL_BEATS * BEAT_DUR + TAIL_SEC) * 1000;
    timeoutsRef.current.push(setTimeout(() => { setPhase('recorded'); setBeatIndex(-1); setCountIn(null); }, totalMs));
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
            <li>Click <strong>Record</strong> — you get a <strong>{COUNT_IN}-beat count-in</strong> at 80 BPM to get ready.</li>
            <li>After the count-in, say <strong>&ldquo;Do&rdquo;</strong> right on each of the {BEATS} clicks.</li>
            <li>Click <strong>Play Back</strong> — you should hear your own &ldquo;Do&rdquo; landing right on the click.</li>
            <li>If it sounds early or late, nudge the <strong>Trim</strong> slider and play back again.</li>
          </ol>

          <div className={styles.trimHint}>
            <div>⬆️ &ldquo;Do&rdquo; lands <strong>after</strong> the click (late) → <strong>increase</strong> Trim.</div>
            <div>⬇️ &ldquo;Do&rdquo; lands <strong>before</strong> the click (early) → <strong>decrease</strong> Trim.</div>
          </div>

          <div className={styles.beatRow}>
            {countIn !== null ? (
              <span className={styles.countInNumber}>Get ready… {countIn}</span>
            ) : (
              Array.from({ length: BEATS }).map((_, i) => (
                <span key={i} className={`${styles.beatDot} ${i === beatIndex ? styles.beatDotActive : ''}`} />
              ))
            )}
          </div>

          <div className={styles.statusText}>
            {phase === 'recording' && countIn !== null && '🎧 Count-in — get ready to sing "Do"…'}
            {phase === 'recording' && countIn === null && `🔴 Say "Do" on the click… (${Math.max(1, beatIndex + 1)}/${BEATS})`}
            {phase === 'playing' && '▶ Listening — does "Do" land on the click?'}
            {phase === 'recorded' && 'Recorded! Play it back, or record again.'}
            {phase === 'intro' && ' '}
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
            <button className={styles.autoBtn} disabled id="latency-helper-auto-btn" title="Coming soon — automatically measure your latency from the recorded click">
              🎯 Auto-detect · soon
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
