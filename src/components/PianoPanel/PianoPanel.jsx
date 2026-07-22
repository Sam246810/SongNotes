import { useState, useRef, useEffect } from 'react';
import styles from './PianoPanel.module.css';
import { getSharedAudioContext } from '../../utils/audioContext';

// Midi notes mapping for piano keyboard
const KEY_MAP = [
  { name: 'C', offset: 0, isBlack: false, keyChar: 'a' },
  { name: 'C#', offset: 1, isBlack: true, keyChar: 'w', leftOffset: 21 },
  { name: 'D', offset: 2, isBlack: false, keyChar: 's' },
  { name: 'D#', offset: 3, isBlack: true, keyChar: 'e', leftOffset: 51 },
  { name: 'E', offset: 4, isBlack: false, keyChar: 'd' },
  { name: 'F', offset: 5, isBlack: false, keyChar: 'f' },
  { name: 'F#', offset: 6, isBlack: true, keyChar: 't', leftOffset: 111 },
  { name: 'G', offset: 7, isBlack: false, keyChar: 'g' },
  { name: 'G#', offset: 8, isBlack: true, keyChar: 'y', leftOffset: 141 },
  { name: 'A', offset: 9, isBlack: false, keyChar: 'h' },
  { name: 'A#', offset: 10, isBlack: true, keyChar: 'u', leftOffset: 171 },
  { name: 'B', offset: 11, isBlack: false, keyChar: 'j' },
  { name: 'C+', offset: 12, isBlack: false, keyChar: 'k' },
  { name: 'C#+', offset: 13, isBlack: true, keyChar: 'o', leftOffset: 231 },
  { name: 'D+', offset: 14, isBlack: false, keyChar: 'l' },
  { name: 'D#+', offset: 15, isBlack: true, keyChar: 'p', leftOffset: 261 },
  { name: 'E+', offset: 16, isBlack: false, keyChar: ';' },
  { name: 'F+', offset: 17, isBlack: false, keyChar: "'" },
];

// Available mp3 sample assets for Salamander Grand Piano
const SAMPLES = [
  { note: 'C1', midi: 24, file: 'C1v13.mp3' },
  { note: 'D#1', midi: 27, file: 'D%231v13.mp3' },
  { note: 'F#1', midi: 30, file: 'F%231v13.mp3' },
  { note: 'A1', midi: 33, file: 'A1v13.mp3' },
  { note: 'C2', midi: 36, file: 'C2v13.mp3' },
  { note: 'D#2', midi: 39, file: 'D%232v13.mp3' },
  { note: 'F#2', midi: 42, file: 'F%232v13.mp3' },
  { note: 'A2', midi: 45, file: 'A2v13.mp3' },
  { note: 'C3', midi: 48, file: 'C3v13.mp3' },
  { note: 'D#3', midi: 51, file: 'D%233v13.mp3' },
  { note: 'F#3', midi: 54, file: 'F%233v13.mp3' },
  { note: 'A3', midi: 57, file: 'A3v13.mp3' },
  { note: 'C4', midi: 60, file: 'C4v13.mp3' },
  { note: 'D#4', midi: 63, file: 'D%234v13.mp3' },
  { note: 'F#4', midi: 66, file: 'F%234v13.mp3' },
  { note: 'A4', midi: 69, file: 'A4v13.mp3' },
  { note: 'C5', midi: 72, file: 'C5v13.mp3' },
  { note: 'D#5', midi: 75, file: 'D%235v13.mp3' },
  { note: 'F#5', midi: 78, file: 'F%235v13.mp3' },
  { note: 'A5', midi: 81, file: 'A5v13.mp3' },
  { note: 'C6', midi: 84, file: 'C6v13.mp3' },
  { note: 'D#6', midi: 87, file: 'D%236v13.mp3' },
  { note: 'F#6', midi: 90, file: 'F%236v13.mp3' },
  { note: 'A6', midi: 93, file: 'A6v13.mp3' },
  { note: 'C7', midi: 96, file: 'C7v13.mp3' },
  { note: 'D#7', midi: 99, file: 'D%237v13.mp3' },
  { note: 'F#7', midi: 102, file: 'F%237v13.mp3' },
  { note: 'A7', midi: 105, file: 'A7v13.mp3' },
  { note: 'C8', midi: 108, file: 'C8v13.mp3' }
];

const SAMPLE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@audio-samples/piano-mp3-velocity13@1.0.5/audio/';

export default function PianoPanel({ embedded }) {
  const [activeNotes, setActiveNotes] = useState([]);
  const [volume, setVolume] = useState(0.4); // volume
  const [octave, setOctave] = useState(4); // active octave
  const [samplesLoading, setSamplesLoading] = useState(false);

  // Metronome state
  const [bpm, setBpm] = useState(120);
  const [isPlayingMetro, setIsPlayingMetro] = useState(false);
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);
  const [currentBeat, setCurrentBeat] = useState(-1);

  // Audio refs
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const pianoWaveRef = useRef(null);
  const activeOscsRef = useRef({});
  const audioBuffersRef = useRef({}); // midi number -> AudioBuffer

  // Metronome refs
  const bpmRef = useRef(bpm);
  const beatsPerMeasureRef = useRef(beatsPerMeasure);
  const nextNoteTimeRef = useRef(0.0);
  const currentBeatRef = useRef(0);
  const timerRef = useRef(null);
  const tapTimesRef = useRef([]);

  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { beatsPerMeasureRef.current = beatsPerMeasure; }, [beatsPerMeasure]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Initialize audio context and start preloading samples immediately on mount
  useEffect(() => {
    initAudio();
  }, []);

  // Preload piano samples for a given octave to avoid lag
  async function preloadOctaveSamples(ctx, octaveVal) {
    const minMidi = (octaveVal + 1) * 12;
    const maxMidi = (octaveVal + 2) * 12 + 5;
    
    // Find closest sample indices
    const requiredSampleMidis = new Set();
    for (let m = minMidi; m <= maxMidi; m++) {
      let closest = SAMPLES[0];
      let minDist = Math.abs(m - closest.midi);
      for (let i = 1; i < SAMPLES.length; i++) {
        const dist = Math.abs(m - SAMPLES[i].midi);
        if (dist < minDist) {
          minDist = dist;
          closest = SAMPLES[i];
        }
      }
      requiredSampleMidis.add(closest.midi);
    }

    setSamplesLoading(true);

    const promises = Array.from(requiredSampleMidis).map(async (midi) => {
      if (audioBuffersRef.current[midi]) return;
      const sample = SAMPLES.find((s) => s.midi === midi);
      if (!sample) return;

      try {
        const res = await fetch(SAMPLE_BASE_URL + sample.file);
        const arrayBuf = await res.arrayBuffer();
        const audioBuf = await ctx.decodeAudioData(arrayBuf);
        audioBuffersRef.current[midi] = audioBuf;
      } catch (err) {
        console.warn('Failed to load grand piano sample for note', sample.note, err);
      }
    });

    await Promise.all(promises);
    setSamplesLoading(false);
  }

  function initAudio() {
    if (!audioCtxRef.current) {
      const ctx = getSharedAudioContext();
      audioCtxRef.current = ctx;
      masterGainRef.current = ctx.createGain();
      masterGainRef.current.gain.value = volume;
      masterGainRef.current.connect(ctx.destination);

      // Create a fallback synthesis wave
      const real = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
      const imag = new Float32Array([0, 1.0, 0.5, 0.25, 0.15, 0.1, 0.05]);
      pianoWaveRef.current = ctx.createPeriodicWave(real, imag);

      // Trigger preloading
      preloadOctaveSamples(ctx, octave);
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
  }

  // Preload when octave changes
  useEffect(() => {
    if (audioCtxRef.current) {
      preloadOctaveSamples(audioCtxRef.current, octave);
    }
  }, [octave]);

  // Update volume
  useEffect(() => {
    if (masterGainRef.current && audioCtxRef.current) {
      masterGainRef.current.gain.setValueAtTime(volume, audioCtxRef.current.currentTime);
    }
  }, [volume]);

  function triggerNoteOn(midi, freq, noteKey) {
    if (samplesLoading) return;
    initAudio();
    if (activeOscsRef.current[noteKey]) return;

    const ctx = audioCtxRef.current;
    const masterGain = masterGainRef.current;
    const now = ctx.currentTime;

    // Find closest sample
    let closestSample = null;
    let minDist = 999;
    for (let i = 0; i < SAMPLES.length; i++) {
      const dist = Math.abs(midi - SAMPLES[i].midi);
      if (dist < minDist) {
        minDist = dist;
        closestSample = SAMPLES[i];
      }
    }

    const buffer = closestSample ? audioBuffersRef.current[closestSample.midi] : null;

    if (buffer) {
      // Play high quality piano sample
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gainNode = ctx.createGain();
      const diff = midi - closestSample.midi;
      source.playbackRate.setValueAtTime(Math.pow(2, diff / 12), now);

      source.connect(gainNode);
      gainNode.connect(masterGain);
      if (window.__dawPianoDestination && window.__dawPianoDestination.context === ctx) {
        try { gainNode.connect(window.__dawPianoDestination); } catch (e) {}
      }

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(1.0, now + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.25, now + 0.8);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 4.0);

      source.start(now);
      activeOscsRef.current[noteKey] = { source, gainNode, isSample: true };
    } else {
      // Synth fallback (synthesis)
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gainNode = ctx.createGain();

      if (pianoWaveRef.current) {
        osc.setPeriodicWave(pianoWaveRef.current);
      } else {
        osc.type = 'triangle';
      }

      osc.frequency.setValueAtTime(freq, now);

      filter.type = 'lowpass';
      filter.Q.setValueAtTime(1.2, now);
      filter.frequency.setValueAtTime(freq * 5.0, now);
      filter.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 1.2);

      osc.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(masterGain);
      if (window.__dawPianoDestination && window.__dawPianoDestination.context === ctx) {
        try { gainNode.connect(window.__dawPianoDestination); } catch (e) {}
      }

      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(0.8, now + 0.005);
      gainNode.gain.exponentialRampToValueAtTime(0.18, now + 0.5);
      gainNode.gain.exponentialRampToValueAtTime(0.005, now + 3.0);

      osc.start(now);
      activeOscsRef.current[noteKey] = { osc, filter, gainNode, isSample: false };
    }

    setActiveNotes((prev) => [...prev, noteKey]);
  }

  function triggerNoteOff(noteKey) {
    const active = activeOscsRef.current[noteKey];
    if (!active) return;

    delete activeOscsRef.current[noteKey];
    setActiveNotes((prev) => prev.filter((n) => n !== noteKey));

    const ctx = audioCtxRef.current;
    if (ctx) {
      const now = ctx.currentTime;
      const { source, osc, filter, gainNode, isSample } = active;
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);

      if (isSample) {
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        setTimeout(() => {
          try {
            source.stop();
            source.disconnect();
            gainNode.disconnect();
          } catch (e) {}
        }, 450);
      } else {
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        setTimeout(() => {
          try {
            osc.stop();
            osc.disconnect();
            filter.disconnect();
            gainNode.disconnect();
          } catch (e) {}
        }, 300);
      }
    }
  }

  function changeOctave(delta) {
    // Prevent stuck notes when switching octaves
    Object.keys(activeOscsRef.current).forEach((k) => {
      triggerNoteOff(k);
    });
    setOctave((prev) => Math.max(1, Math.min(7, prev + delta)));
  }

  // Calculate notes based on octave
  const keys = KEY_MAP.map((k) => {
    const midi = (octave + 1) * 12 + k.offset;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const displayOctave = octave + (k.offset >= 12 ? 1 : 0);
    const displayNote = k.name.replace('+', '') + displayOctave;
    return {
      ...k,
      midi,
      freq,
      displayNote,
      noteKey: k.name + octave,
    };
  });

  // Global Keyboard event handler for computer keyboard playing
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.repeat) return;

      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        changeOctave(-1);
        return;
      }
      if (key === 'x') {
        e.preventDefault();
        changeOctave(1);
        return;
      }

      const note = keys.find((n) => n.keyChar === key);
      if (note) {
        e.preventDefault();
        triggerNoteOn(note.midi, note.freq, note.noteKey);
      }
    }

    function handleKeyUp(e) {
      const key = e.key.toLowerCase();
      const note = keys.find((n) => n.keyChar === key);
      if (note) {
        triggerNoteOff(note.noteKey);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [octave, keys]);

  // Metronome scheduler
  function scheduler() {
    const ctx = audioCtxRef.current;
    const masterGain = masterGainRef.current;
    if (!ctx || !masterGain) return;

    const scheduleAheadTime = 0.1;

    while (nextNoteTimeRef.current < ctx.currentTime + scheduleAheadTime) {
      const time = nextNoteTimeRef.current;
      const beat = currentBeatRef.current;

      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(masterGain);

      osc.frequency.setValueAtTime(beat === 0 ? 1000 : 700, time);
      gainNode.gain.setValueAtTime(0.4, time);
      gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

      osc.start(time);
      osc.stop(time + 0.05);

      const delayMs = (time - ctx.currentTime) * 1000;
      setTimeout(() => {
        setCurrentBeat(beat);
      }, Math.max(0, delayMs));

      nextNoteTimeRef.current += 60.0 / bpmRef.current;
      currentBeatRef.current = (currentBeatRef.current + 1) % beatsPerMeasureRef.current;
    }
  }

  // Listen for stop-piano-metronome event
  useEffect(() => {
    function handleStopPianoMetro() {
      if (isPlayingMetro) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        setIsPlayingMetro(false);
        setCurrentBeat(-1);
      }
    }
    window.addEventListener('stop-piano-metronome', handleStopPianoMetro);
    return () => window.removeEventListener('stop-piano-metronome', handleStopPianoMetro);
  }, [isPlayingMetro]);

  function handleToggleMetro() {
    initAudio();
    if (isPlayingMetro) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      setIsPlayingMetro(false);
      setCurrentBeat(-1);
    } else {
      window.dispatchEvent(new CustomEvent('stop-daw-metronome'));
      window.dispatchEvent(new CustomEvent('stop-daw-recording'));

      nextNoteTimeRef.current = audioCtxRef.current.currentTime + 0.05;
      currentBeatRef.current = 0;
      setIsPlayingMetro(true);
      timerRef.current = setInterval(() => scheduler(), 25);
    }
  }

  function handleTapTempo() {
    const now = Date.now();
    const times = tapTimesRef.current;

    if (times.length > 0 && now - times[times.length - 1] > 2000) {
      times.length = 0;
    }

    times.push(now);
    if (times.length >= 2) {
      const diffs = [];
      for (let i = 1; i < times.length; i++) {
        diffs.push(times[i] - times[i - 1]);
      }
      const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const calculatedBpm = Math.round(60000 / avgDiff);
      if (calculatedBpm >= 40 && calculatedBpm <= 240) {
        setBpm(calculatedBpm);
      }
    }
  }

  const whiteKeys = keys.filter((n) => !n.isBlack);
  const blackKeys = keys.filter((n) => n.isBlack);

  if (embedded) {
    return (
      <div className={styles.embeddedPianoContainer}>
        <div className={styles.embeddedHeader}>
          <span className={styles.embeddedTitle}>🎹 Piano Keyboard</span>
          <div className={styles.embeddedControls}>
            <button
              className={styles.octaveBtnCompact}
              onClick={() => changeOctave(-1)}
              disabled={octave <= 1}
              id="octave-down-btn"
            >
              ◀
            </button>
            <span className={styles.octaveValCompact}>Octave {octave}</span>
            <button
              className={styles.octaveBtnCompact}
              onClick={() => changeOctave(1)}
              disabled={octave >= 7}
              id="octave-up-btn"
            >
              ▶
            </button>

            <span style={{ marginLeft: '16px', fontSize: '12px' }}>🔊 Vol</span>
            <input
              type="range"
              min="0"
              max="0.8"
              step="0.05"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className={styles.sliderCompact}
              title="Piano Volume"
            />

            {samplesLoading && <span className={styles.loadingTextCompact}>⏳ Loading samples...</span>}
          </div>
        </div>

        <div className={styles.keyboardWrapperCompact}>
          <div className={styles.keyboard}>
            {/* White Keys */}
            {whiteKeys.map((wk) => {
              const active = activeNotes.includes(wk.noteKey);
              return (
                <div
                  key={wk.noteKey}
                  className={`${styles.whiteKey} ${active ? styles.whiteKeyActive : ''}`}
                  onMouseDown={() => triggerNoteOn(wk.midi, wk.freq, wk.noteKey)}
                  onMouseUp={() => triggerNoteOff(wk.noteKey)}
                  onMouseLeave={() => triggerNoteOff(wk.noteKey)}
                >
                  <span className={styles.keyLabel}>{wk.displayNote}</span>
                  <span className={styles.keyCharLabel}>{wk.keyChar}</span>
                </div>
              );
            })}

            {/* Black Keys */}
            {blackKeys.map((bk) => {
              const active = activeNotes.includes(bk.noteKey);
              return (
                <div
                  key={bk.noteKey}
                  className={`${styles.blackKey} ${active ? styles.blackKeyActive : ''}`}
                  style={{ left: `${bk.leftOffset}px` }}
                  onMouseDown={() => triggerNoteOn(bk.midi, bk.freq, bk.noteKey)}
                  onMouseUp={() => triggerNoteOff(bk.noteKey)}
                  onMouseLeave={() => triggerNoteOff(bk.noteKey)}
                >
                  <span className={styles.keyLabel}>{bk.displayNote}</span>
                  <span className={styles.keyCharLabel}>{bk.keyChar}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {/* Volume Controls */}
      <div className={styles.section}>
        <div className={styles.title}>Master Volume</div>
        <div className={styles.volumeControls}>
          <div className={styles.volumeRow}>
            <span className={styles.volumeIcon}>🔊</span>
            <input
              type="range"
              min="0"
              max="0.8"
              step="0.05"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className={styles.slider}
              aria-label="Volume slider"
            />
            <span style={{ fontSize: '12px', width: '30px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              {Math.round(volume * 125)}%
            </span>
          </div>
        </div>
      </div>

      {/* Octave Controls */}
      <div className={styles.section}>
        <div className={styles.title}>Octave Control</div>
        <div className={styles.octaveControls}>
          <button
            className={styles.octaveBtn}
            onClick={() => changeOctave(-1)}
            disabled={octave <= 1}
            id="octave-down-btn"
          >
            ◀ Down (Z)
          </button>
          <div className={styles.octaveVal}>
            Octave {octave}
            {samplesLoading && <span style={{ fontSize: '10px', color: 'var(--accent)', marginLeft: '6px' }}>⏳</span>}
          </div>
          <button
            className={styles.octaveBtn}
            onClick={() => changeOctave(1)}
            disabled={octave >= 7}
            id="octave-up-btn"
          >
            Up (X) ▶
          </button>
        </div>
      </div>

      {/* Metronome Section */}
      <div className={styles.section}>
        <div className={styles.title}>Metronome</div>
        <div className={styles.metroControls}>
          <div className={styles.bpmDisplay}>
            <div className={styles.bpmVal}>{bpm}</div>
            <div className={styles.bpmLabel}>BPM</div>
            <select
              value={beatsPerMeasure}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                setBeatsPerMeasure(val);
                if (isPlayingMetro) {
                  currentBeatRef.current = 0;
                }
              }}
              className={styles.timeSigSelect}
              aria-label="Time signature beats per measure"
            >
              <option value="2">2/4</option>
              <option value="3">3/4</option>
              <option value="4">4/4</option>
              <option value="6">6/8</option>
            </select>
          </div>

          <div className={styles.sliderRow}>
            <input
              type="range"
              min="40"
              max="240"
              value={bpm}
              onChange={(e) => setBpm(parseInt(e.target.value, 10))}
              className={styles.slider}
              aria-label="BPM slider"
            />
          </div>

          <div className={styles.btnRow}>
            <button
              onClick={handleToggleMetro}
              className={`${styles.actionBtn} ${isPlayingMetro ? styles.actionBtnActive : ''}`}
            >
              {isPlayingMetro ? '⏹ Stop' : '▶ Start'}
            </button>
            <button onClick={handleTapTempo} className={styles.actionBtn}>
              🥁 Tap
            </button>
          </div>

          {/* Visual beat flash indicators */}
          <div className={styles.beatsRow}>
            {Array.from({ length: beatsPerMeasure }).map((_, i) => (
              <div
                key={i}
                className={`${styles.beatDot} ${
                  currentBeat === i
                    ? i === 0
                      ? styles.beatDotFirstActive
                      : styles.beatDotActive
                    : ''
                }`}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Piano Keyboard Section */}
      <div className={styles.section}>
        <div className={styles.title}>Playable Piano</div>
        <div className={styles.pianoContainer}>
          <div className={styles.keyboardWrapper}>
            <div className={styles.keyboard}>
              {/* White Keys */}
              {whiteKeys.map((wk) => {
                const active = activeNotes.includes(wk.noteKey);
                return (
                  <div
                    key={wk.noteKey}
                    className={`${styles.whiteKey} ${active ? styles.whiteKeyActive : ''}`}
                    onMouseDown={() => triggerNoteOn(wk.midi, wk.freq, wk.noteKey)}
                    onMouseUp={() => triggerNoteOff(wk.noteKey)}
                    onMouseLeave={() => triggerNoteOff(wk.noteKey)}
                  >
                    <span className={styles.keyLabel}>{wk.displayNote}</span>
                    <span className={styles.keyCharLabel}>{wk.keyChar}</span>
                  </div>
                );
              })}

              {/* Black Keys */}
              {blackKeys.map((bk) => {
                const active = activeNotes.includes(bk.noteKey);
                return (
                  <div
                    key={bk.noteKey}
                    className={`${styles.blackKey} ${active ? styles.blackKeyActive : ''}`}
                    style={{ left: `${bk.leftOffset}px` }}
                    onMouseDown={() => triggerNoteOn(bk.midi, bk.freq, bk.noteKey)}
                    onMouseUp={() => triggerNoteOff(bk.noteKey)}
                    onMouseLeave={() => triggerNoteOff(bk.noteKey)}
                  >
                    <span className={styles.keyLabel}>{bk.displayNote}</span>
                    <span className={styles.keyCharLabel}>{bk.keyChar}</span>
                  </div>
                );
              })}
            </div>
            {samplesLoading && (
              <div className={styles.loadingOverlay}>
                <div className={styles.spinner}></div>
                <div className={styles.loadingText}>Loading Piano Samples...</div>
              </div>
            )}
          </div>
          <div className={styles.keyHint}>
            Use 'Z' / 'X' to change octaves. Play notes with keyboard when not typing lyrics!
          </div>
        </div>
      </div>
    </div>
  );
}
