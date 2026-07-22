import { useEffect, useRef, useState } from 'react';
import styles from './LatencyTrimHelper.module.css';
import { getSharedAudioContext } from '../../utils/audioContext';
import { setStoredLatencyTrimMs, setStoredPianoTrimMs, markLatencyTrimHelperSeen } from '../../utils/latencyTrimSettings';
import {
  LOW_LATENCY_MIC_CONSTRAINTS,
  RECORD_PREROLL_SEC,
  ensureRecorderLoaded,
  createRecorder,
  RECORDER_MIC_INPUT,
  RECORDER_PIANO_INPUT,
  measureLatencies,
} from '../../audio/recorderEngine';
import {
  compensationSeconds,
  headSkipSamples,
} from '../../audio/latency';

const BPM = 80;
const BEAT_DUR = 60 / BPM;
const BEATS = 8;
const COUNT_IN = 4; // preparatory beats before the recording beats
const TOTAL_BEATS = COUNT_IN + BEATS;
const TAIL_SEC = 0.5;

/**
 * Schedule a click track: COUNT_IN softer preparatory beats, then BEATS accented
 * recording beats. onBeat(i) fires per beat with the raw index (0..TOTAL_BEATS-1).
 */
function scheduleClickTrack(ctx, startTime, destination, onBeat) {
  const timeouts = [];
  for (let i = 0; i < TOTAL_BEATS; i++) {
    const t = startTime + i * BEAT_DUR;
    const isCountIn = i < COUNT_IN;
    const recBeat = i - COUNT_IN;

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
  return timeouts;
}

/** Play a short synthesised piano-ish note now, into each destination. */
function playPianoNote(ctx, destinations) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(523.25, t); // C5
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(gain);
  destinations.forEach((d) => { if (d) gain.connect(d); });
  osc.start(t);
  osc.stop(t + 0.35);
}

export default function LatencyTrimHelper({ initialTrimMs, initialPianoTrimMs, onSave, onClose }) {
  const [step, setStep] = useState('voice'); // 'voice' | 'piano'
  const [phase, setPhase] = useState('intro'); // intro | recording | recorded | playing
  const [beatIndex, setBeatIndex] = useState(-1);
  const [countIn, setCountIn] = useState(null);
  const [voiceTrimMs, setVoiceTrimMs] = useState(initialTrimMs);
  const [pianoTrimMs, setPianoTrimMs] = useState(initialPianoTrimMs ?? 0);
  const [hasRecording, setHasRecording] = useState(false);
  const [micError, setMicError] = useState(false);

  const recorderRef = useRef(null);
  const sinkRef = useRef(null);
  const micStreamRef = useRef(null);
  const pianoDestRef = useRef(null);
  const keydownRef = useRef(null);
  const timeoutsRef = useRef([]);
  const takeRef = useRef(null); // { source, pcm, startFrame, sampleRate, transportStartTime, latencies }

  const isPiano = step === 'piano';
  const source = isPiano ? 'piano' : 'mic';
  const trimMs = isPiano ? pianoTrimMs : voiceTrimMs;
  const setTrimMs = isPiano ? setPianoTrimMs : setVoiceTrimMs;
  const busy = phase === 'recording' || phase === 'playing';
  const actionWord = isPiano ? 'tap' : 'sing';

  const clearScheduled = () => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
  };

  const removeKeyListener = () => {
    if (keydownRef.current) {
      window.removeEventListener('keydown', keydownRef.current);
      keydownRef.current = null;
    }
  };

  const teardown = () => {
    clearScheduled();
    removeKeyListener();
    try { if (recorderRef.current) recorderRef.current.node.disconnect(); } catch { /* noop */ }
    recorderRef.current = null;
    try { if (sinkRef.current) sinkRef.current.disconnect(); } catch { /* noop */ }
    sinkRef.current = null;
    try { if (pianoDestRef.current) pianoDestRef.current.disconnect(); } catch { /* noop */ }
    pianoDestRef.current = null;
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
  };

  useEffect(() => teardown, []);

  const resetTakeState = () => {
    teardown();
    takeRef.current = null;
    setPhase('intro');
    setHasRecording(false);
    setBeatIndex(-1);
    setCountIn(null);
    setMicError(false);
  };

  const goToStep = (next) => {
    resetTakeState();
    setStep(next);
  };

  const handleBeat = (i) => {
    if (i < COUNT_IN) {
      setCountIn(COUNT_IN - i);
      setBeatIndex(-1);
    } else {
      setCountIn(null);
      setBeatIndex(i - COUNT_IN);
    }
  };

  // Live tap during the piano step: play a note into the recorder + speakers.
  const handleTap = () => {
    if (!isPiano || phase !== 'recording') return;
    const ctx = getSharedAudioContext();
    playPianoNote(ctx, [ctx.destination, pianoDestRef.current]);
  };

  const handleRecord = async () => {
    clearScheduled();
    removeKeyListener();
    setMicError(false);
    setCountIn(null);
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    let micTrack = null;

    // Mic (voice step only) — request before loading the worklet so a denial exits early.
    if (!isPiano) {
      try {
        micStreamRef.current = await navigator.mediaDevices.getUserMedia(LOW_LATENCY_MIC_CONSTRAINTS);
      } catch {
        setMicError(true);
        return;
      }
      micTrack = micStreamRef.current.getAudioTracks()[0] || null;
    }

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

    if (isPiano) {
      // Piano notes (from taps) are routed into recorder input 1.
      const pianoDest = ctx.createGain();
      pianoDest.connect(recorder.node, 0, RECORDER_PIANO_INPUT);
      pianoDestRef.current = pianoDest;
      // Let the spacebar act as a tap too.
      const onKey = (e) => {
        if (e.repeat) return;
        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          handleTap();
        }
      };
      window.addEventListener('keydown', onKey);
      keydownRef.current = onKey;
    } else {
      const micSource = ctx.createMediaStreamSource(micStreamRef.current);
      micSource.connect(recorder.node, 0, RECORDER_MIC_INPUT);
    }

    const latencies = measureLatencies(ctx, micTrack);

    const clickGain = ctx.createGain();
    clickGain.gain.value = 0.6;
    clickGain.connect(ctx.destination);

    const startTime = ctx.currentTime + RECORD_PREROLL_SEC;
    setPhase('recording');
    setBeatIndex(-1);
    timeoutsRef.current = scheduleClickTrack(ctx, startTime, clickGain, handleBeat);

    const stopDelayMs = (startTime - ctx.currentTime) * 1000 + (TOTAL_BEATS * BEAT_DUR + TAIL_SEC) * 1000;
    timeoutsRef.current.push(setTimeout(async () => {
      removeKeyListener();
      let result = null;
      try {
        result = await recorder.stop();
      } catch (e) {
        console.error('Recorder flush failed:', e);
      }
      teardown();
      if (result && result.samples > 0) {
        takeRef.current = {
          source,
          pcm: isPiano ? result.pianoPcm : result.micPcm,
          startFrame: result.startFrame,
          sampleRate: result.sampleRate,
          transportStartTime: startTime,
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
    if (!take || !take.pcm) return;
    clearScheduled();

    const ctx = getSharedAudioContext();
    const compensationSec = compensationSeconds(take.latencies, take.source, trimMs);
    const skip = headSkipSamples({
      transportStartTime: take.transportStartTime,
      recordStartFrame: take.startFrame,
      sampleRate: take.sampleRate,
      compensationSec,
    });
    const safeSkip = Math.min(skip, Math.max(0, take.pcm.length - 1));
    const aligned = take.pcm.subarray(safeSkip);

    const buffer = ctx.createBuffer(1, Math.max(1, aligned.length), take.sampleRate);
    buffer.getChannelData(0).set(aligned);

    const takeGain = ctx.createGain();
    takeGain.gain.value = 1;
    takeGain.connect(ctx.destination);

    const clickGain = ctx.createGain();
    clickGain.gain.value = 0.6;
    clickGain.connect(ctx.destination);

    const bufSource = ctx.createBufferSource();
    bufSource.buffer = buffer;
    bufSource.connect(takeGain);

    const startTime = ctx.currentTime + 0.15;
    bufSource.start(startTime);

    setPhase('playing');
    setBeatIndex(-1);
    timeoutsRef.current = scheduleClickTrack(ctx, startTime, clickGain, handleBeat);

    const totalMs = (startTime - ctx.currentTime) * 1000 + (TOTAL_BEATS * BEAT_DUR + TAIL_SEC) * 1000;
    timeoutsRef.current.push(setTimeout(() => { setPhase('recorded'); setBeatIndex(-1); setCountIn(null); }, totalMs));
  };

  const handleSave = () => {
    setStoredLatencyTrimMs(voiceTrimMs);
    setStoredPianoTrimMs(pianoTrimMs);
    markLatencyTrimHelperSeen();
    onSave({ trimMs: voiceTrimMs, pianoTrimMs });
  };

  const handleSkip = () => {
    markLatencyTrimHelperSeen();
    onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={handleSkip}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>{isPiano ? '🎹 Calibrate Piano' : '🎤 Calibrate Voice'}</h3>
          <span className={styles.stepBadge}>Step {isPiano ? 2 : 1} of 2</span>
          <button className={styles.closeModalBtn} onClick={handleSkip} title="Skip for now" id="latency-helper-skip-btn">✕</button>
        </div>

        <div className={styles.modalBody}>
          <p className={styles.introText}>
            Your mic, speakers and piano each add a small delay that can throw recordings out of
            sync. Let's line them up once — it applies to every song from now on.
          </p>

          {isPiano ? (
            <ol className={styles.stepsList}>
              <li>Click <strong>Record</strong> — you get a <strong>{COUNT_IN}-beat count-in</strong> at 80 BPM.</li>
              <li>After the count-in, <strong>tap the pad</strong> (or press <strong>Space</strong>) right on each of the {BEATS} clicks.</li>
              <li>Click <strong>Play Back</strong> — your taps should land right on the click.</li>
              <li>If they sound early or late, nudge the <strong>Trim</strong> slider and play back again.</li>
            </ol>
          ) : (
            <ol className={styles.stepsList}>
              <li>Click <strong>Record</strong> — you get a <strong>{COUNT_IN}-beat count-in</strong> at 80 BPM.</li>
              <li>After the count-in, say <strong>&ldquo;Do&rdquo;</strong> right on each of the {BEATS} clicks.</li>
              <li>Click <strong>Play Back</strong> — your &ldquo;Do&rdquo; should land right on the click.</li>
              <li>If it sounds early or late, nudge the <strong>Trim</strong> slider and play back again.</li>
            </ol>
          )}

          <div className={styles.trimHint}>
            <div>⬆️ Lands <strong>after</strong> the click (late) → <strong>increase</strong> Trim.</div>
            <div>⬇️ Lands <strong>before</strong> the click (early) → <strong>decrease</strong> Trim.</div>
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

          {isPiano && phase === 'recording' && countIn === null && (
            <button
              className={styles.tapPad}
              onMouseDown={handleTap}
              id="latency-helper-tap-btn"
            >
              🎹 TAP on each click
            </button>
          )}

          <div className={styles.statusText}>
            {phase === 'recording' && countIn !== null && '🎧 Count-in — get ready…'}
            {phase === 'recording' && countIn === null && `🔴 ${isPiano ? 'Tap' : 'Say "Do"'} on the click… (${Math.max(1, beatIndex + 1)}/${BEATS})`}
            {phase === 'playing' && `▶ Listening — does your ${actionWord} land on the click?`}
            {phase === 'recorded' && 'Recorded! Play it back, or record again.'}
            {phase === 'intro' && ' '}
          </div>

          {micError && (
            <div className={styles.errorText}>Microphone access is required to calibrate the voice.</div>
          )}

          <div className={styles.trimRow}>
            <span className={styles.trimLabel}>{isPiano ? '🎹' : '🎤'} Trim</span>
            <input
              type="range"
              min={isPiano ? -50 : -10} max="40" step="1"
              value={trimMs}
              onChange={(e) => setTrimMs(parseInt(e.target.value, 10))}
              className={styles.trimSlider}
              title={`${isPiano ? 'Piano' : 'Voice'} latency trim: ${trimMs}ms`}
              id={isPiano ? 'latency-helper-piano-trim' : 'latency-helper-voice-trim'}
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
            {isPiano ? (
              <button className={styles.skipBtn} onClick={() => goToStep('voice')} disabled={busy} id="latency-helper-back-btn">
                ← Back to Voice
              </button>
            ) : (
              <button className={styles.skipBtn} onClick={handleSkip} id="latency-helper-skip-footer-btn">
                Skip for now
              </button>
            )}
            {isPiano ? (
              <button className={styles.saveBtn} onClick={handleSave} disabled={busy} id="latency-helper-save-btn">
                ✅ Save Both
              </button>
            ) : (
              <button className={styles.saveBtn} onClick={() => goToStep('piano')} disabled={busy} id="latency-helper-next-btn">
                Next: Piano →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
