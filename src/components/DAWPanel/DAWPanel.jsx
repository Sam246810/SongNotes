import { useState, useRef, useEffect } from 'react';
import styles from './DAWPanel.module.css';
import { getSharedAudioContext } from '../../utils/audioContext';
import { audioBufferToWav, audioBufferToMp3, mixTracksToMasterBuffer, downloadAudioBlob, sanitizeAudioFilename } from '../../utils/audioExport';
import { getStoredLatencyTrimMs, setStoredLatencyTrimMs, getStoredPianoTrimMs, setStoredPianoTrimMs, hasSeenLatencyTrimHelper } from '../../utils/latencyTrimSettings';
import {
  LOW_LATENCY_MIC_CONSTRAINTS,
  RECORD_PREROLL_SEC,
  ensureRecorderLoaded,
  createRecorder,
  RECORDER_MIC_INPUT,
  RECORDER_PIANO_INPUT,
  buildTrackBuffer,
  measureLatencies,
} from '../../audio/recorderEngine';
import PianoPanel from '../PianoPanel/PianoPanel';
import LatencyTrimHelper from '../LatencyTrimHelper/LatencyTrimHelper';

/**
 * WaveformCanvas Component — Renders peak waveform shapes for audio buffers
 * or dynamic animated pulse waves during active recording.
 */
function WaveformCanvas({ audioBuffer, width, height, isRecording }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (audioBuffer) {
      const data = audioBuffer.getChannelData(0);
      const step = Math.ceil(data.length / Math.max(1, w));
      const amp = h / 2;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();

      for (let i = 0; i < w; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
          const datum = data[i * step + j];
          if (datum !== undefined) {
            if (datum < min) min = datum;
            if (datum > max) max = datum;
          }
        }
        const yMin = Math.max(0, (1 + min) * amp);
        const yMax = Math.min(h, Math.max(yMin + 1, (1 + max) * amp));
        ctx.fillRect(i, yMin, 1.5, Math.max(1, yMax - yMin));
      }
    } else if (isRecording) {
      let animationFrameId;
      let phase = 0;

      const render = () => {
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        const mid = h / 2;
        ctx.moveTo(0, mid);
        for (let x = 0; x < w; x++) {
          const v = Math.sin((x * 0.08) + phase) * (h * 0.3) * (0.6 + 0.4 * Math.sin(x * 0.03 + phase * 2));
          ctx.lineTo(x, mid + v);
        }
        ctx.stroke();
        phase += 0.15;
        animationFrameId = requestAnimationFrame(render);
      };

      render();
      return () => cancelAnimationFrame(animationFrameId);
    }
  }, [audioBuffer, width, height, isRecording]);

  return <canvas ref={canvasRef} width={Math.max(10, Math.floor(width))} height={height} className={styles.clipCanvas} />;
}

/**
 * OS-aware default pipeline overhead (ms).
 * Accounts for audio mixer / driver overhead that no Web Audio API property reports.
 */
function getDefaultPipelineOverheadMs() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua))  return 18; // WASAPI shared-mode mixer
  if (/Mac OS X|Macintosh/i.test(ua)) return 5;  // CoreAudio — very tight
  if (/Linux/i.test(ua))    return 12; // PulseAudio / PipeWire
  if (/CrOS/i.test(ua))     return 10; // ChromeOS
  return 10; // safe default
}

export default function DAWPanel({ showPiano, onTogglePiano, showDaw, onToggleDaw }) {
  const [tracks, setTracks] = useState([
    { id: '1', name: 'Vocals', inputType: 'mic', audioBuffer: null, volume: 0.8, isMuted: false, isSoloed: false, isArmed: true, duration: 0 },
    { id: '2', name: 'Grand Piano', inputType: 'piano', audioBuffer: null, volume: 0.8, isMuted: false, isSoloed: false, isArmed: false, duration: 0 },
  ]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [playhead, setPlayhead] = useState(0); // in seconds
  const [masterVolume, setMasterVolume] = useState(0.8);
  const [recordingStartTime, setRecordingStartTime] = useState(0);

  // DAW Metronome state
  const [bpm, setBpm] = useState(120);
  const [bpmInput, setBpmInput] = useState('120');
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);
  const [isMetroOn, setIsMetroOn] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const exportAudioRef = useRef(null);

  // Close audio export dropdown on outside click
  useEffect(() => {
    if (!showExportMenu) return;
    function onClickOutside(e) {
      if (exportAudioRef.current && !exportAudioRef.current.contains(e.target)) {
        setShowExportMenu(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showExportMenu]);

  const hasRecordedAudio = tracks.some(t => t.audioBuffer);
  const tracksWithAudio = tracks.filter(t => t.audioBuffer);

  const handleExportMaster = async (format) => {
    const master = mixTracksToMasterBuffer(tracks, audioCtxRef.current);
    if (!master) {
      alert("No recorded audio tracks available to export.");
      return;
    }
    const blob = format === 'mp3' ? await audioBufferToMp3(master) : audioBufferToWav(master);
    const filename = `${sanitizeAudioFilename('Master_Mix')}.${format}`;
    downloadAudioBlob(blob, filename);
    setShowExportMenu(false);
  };

  const handleExportSingleTrack = async (track, format) => {
    if (!track.audioBuffer) return;
    const blob = format === 'mp3' ? await audioBufferToMp3(track.audioBuffer) : audioBufferToWav(track.audioBuffer);
    const filename = `${sanitizeAudioFilename(track.name)}.${format}`;
    downloadAudioBlob(blob, filename);
    setShowExportMenu(false);
  };

  // Resizable Panel Width state
  const [panelWidth, setPanelWidth] = useState(480);
  const [isResizing, setIsResizing] = useState(false);

  // Latency trim (ms) — OS-detected default, user-adjustable, persisted globally across songs
  const [latencyTrimMs, setLatencyTrimMs] = useState(() => getStoredLatencyTrimMs(getDefaultPipelineOverheadMs()));
  // Extra trim applied to piano takes only (they have no ADC input latency, so they
  // tend to land ahead of vocals). Persisted globally like the voice trim.
  const [pianoTrimMs, setPianoTrimMs] = useState(() => getStoredPianoTrimMs(0));
  const [showLatencyHelper, setShowLatencyHelper] = useState(false);

  // Persist trim changes globally so every song shares the same calibrated values
  useEffect(() => {
    setStoredLatencyTrimMs(latencyTrimMs);
  }, [latencyTrimMs]);

  useEffect(() => {
    setStoredPianoTrimMs(pianoTrimMs);
  }, [pianoTrimMs]);

  // Launch the calibration helper the very first time the Scratchpad is opened —
  // never again afterwards, since the trim setting is global from then on.
  useEffect(() => {
    if (!hasSeenLatencyTrimHelper()) {
      setShowLatencyHelper(true);
    }
  }, []);

  // Resizable Track Heights state (trackId -> height in px)
  const [trackHeights, setTrackHeights] = useState({});
  const [resizingTrack, setResizingTrack] = useState(null); // { id, startY, startHeight }

  // Handle vertical dragging of individual track headers/rows
  useEffect(() => {
    if (!resizingTrack) return;

    const handleMouseMove = (e) => {
      const deltaY = e.clientY - resizingTrack.startY;
      const newHeight = Math.max(48, Math.min(220, resizingTrack.startHeight + deltaY));
      setTrackHeights((prev) => ({
        ...prev,
        [resizingTrack.id]: newHeight,
      }));
    };

    const handleMouseUp = () => {
      setResizingTrack(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingTrack]);

  const startTrackResize = (trackId, e) => {
    e.preventDefault();
    const currentHeight = trackHeights[trackId] || 68;
    setResizingTrack({
      id: trackId,
      startY: e.clientY,
      startHeight: currentHeight,
    });
  };

  // Audio refs
  const panelRef = useRef(null);
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const trackSourcesRef = useRef({}); // trackId -> { source, gainNode }
  const recorderRef = useRef(null); // { node, stop } from the shared recorder engine
  const recorderSinkRef = useRef(null); // zero-gain sink keeping the worklet pulled
  const micStreamRef = useRef(null);
  const micTrackRef = useRef(null); // live MediaStreamTrack for latency readout
  const latenciesRef = useRef({ base: 0, output: 0, input: 0 });
  const transportStartTimeRef = useRef(0); // ctx time of the transport downbeat (T0)
  const playheadRafRef = useRef(null);
  const startTimeRef = useRef(0);

  // Metronome refs
  const bpmRef = useRef(bpm);
  const beatsPerMeasureRef = useRef(beatsPerMeasure);
  const nextNoteTimeRef = useRef(0.0);
  const currentBeatRef = useRef(0);
  const metroTimerRef = useRef(null);

  useEffect(() => { bpmRef.current = bpm; setBpmInput(bpm.toString()); }, [bpm]);
  useEffect(() => { beatsPerMeasureRef.current = beatsPerMeasure; }, [beatsPerMeasure]);

  const handleBpmChange = (e) => {
    const val = e.target.value;
    setBpmInput(val);
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= 40 && num <= 240) {
      setBpm(num);
    }
  };

  const handleBpmBlur = () => {
    const num = parseInt(bpmInput, 10);
    if (isNaN(num) || num < 40) {
      setBpm(40);
      setBpmInput('40');
    } else if (num > 240) {
      setBpm(240);
      setBpmInput('240');
    } else {
      setBpm(num);
      setBpmInput(num.toString());
    }
  };

  // Resizing event handlers
  const startResizing = (e) => {
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing) return;
      const newWidth = window.innerWidth - e.clientX;
      setPanelWidth(Math.max(380, Math.min(950, newWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  const toggleExpandPanel = () => {
    setPanelWidth((prev) => (prev > 600 ? 480 : 800));
  };

  // Sync window events for metronome mutual exclusion
  useEffect(() => {
    function handleStopDawMetro() {
      setIsMetroOn(false);
    }
    function handleStopDawRecording() {
      handleStop();
    }
    window.addEventListener('stop-daw-metronome', handleStopDawMetro);
    window.addEventListener('stop-daw-recording', handleStopDawRecording);
    return () => {
      window.removeEventListener('stop-daw-metronome', handleStopDawMetro);
      window.removeEventListener('stop-daw-recording', handleStopDawRecording);
    };
  }, [isPlaying, isRecording]);

  // Initialize AudioContext
  function initAudio() {
    if (!audioCtxRef.current) {
      const ctx = getSharedAudioContext();
      audioCtxRef.current = ctx;
      masterGainRef.current = ctx.createGain();
      masterGainRef.current.gain.value = masterVolume;
      masterGainRef.current.connect(ctx.destination);
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
  }

  // Update master volume
  useEffect(() => {
    if (masterGainRef.current && audioCtxRef.current) {
      masterGainRef.current.gain.setValueAtTime(masterVolume, audioCtxRef.current.currentTime);
    }
  }, [masterVolume]);

  // Update track volumes and mutes
  useEffect(() => {
    if (!audioCtxRef.current) return;
    const anySolo = tracks.some(t => t.isSoloed);
    tracks.forEach(track => {
      const ts = trackSourcesRef.current[track.id];
      if (ts && ts.gainNode) {
        let effectiveVol = track.volume;
        if (track.isMuted) effectiveVol = 0;
        if (anySolo && !track.isSoloed) effectiveVol = 0;
        ts.gainNode.gain.setValueAtTime(effectiveVol, audioCtxRef.current.currentTime);
      }
    });
  }, [tracks]);

  // DAW Metronome scheduler
  function metroScheduler() {
    const ctx = audioCtxRef.current;
    const masterGain = masterGainRef.current;
    if (!ctx || !masterGain || !isMetroOn) return;

    const scheduleAheadTime = 0.1;

    while (nextNoteTimeRef.current < ctx.currentTime + scheduleAheadTime) {
      const time = nextNoteTimeRef.current;
      const beat = currentBeatRef.current;

      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(masterGain);

      osc.frequency.setValueAtTime(beat === 0 ? 1000 : 700, time);
      gainNode.gain.setValueAtTime(0.35, time);
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

  // Metronome loop manager
  useEffect(() => {
    if (isMetroOn && (isPlaying || isRecording)) {
      initAudio();
      // Align the downbeat to the transport start (T0). While recording, T0 sits a
      // pre-roll ahead so the first click coincides exactly with sample-accurate
      // capture; otherwise fall back to a small scheduling lead.
      const now = audioCtxRef.current.currentTime;
      const t0 = transportStartTimeRef.current;
      nextNoteTimeRef.current = (t0 && t0 > now) ? t0 : now + 0.05;
      currentBeatRef.current = 0;
      metroTimerRef.current = setInterval(() => metroScheduler(), 25);
    } else {
      if (metroTimerRef.current) clearInterval(metroTimerRef.current);
      metroTimerRef.current = null;
      setCurrentBeat(-1);
    }
    return () => {
      if (metroTimerRef.current) clearInterval(metroTimerRef.current);
    };
  }, [isMetroOn, isPlaying, isRecording]);

  const handleToggleMetro = () => {
    initAudio();
    if (!isMetroOn) {
      window.dispatchEvent(new CustomEvent('stop-piano-metronome'));
      setIsMetroOn(true);
    } else {
      setIsMetroOn(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPlayback();
      teardownRecordingGraph();
      if (metroTimerRef.current) clearInterval(metroTimerRef.current);
      cancelAnimationFrame(playheadRafRef.current);
    };
  }, []);

  // Tear down the mic/piano/worklet recording graph (safe to call repeatedly).
  const teardownRecordingGraph = () => {
    try { if (recorderRef.current) recorderRef.current.node.disconnect(); } catch (e) {}
    recorderRef.current = null;
    try { if (recorderSinkRef.current) recorderSinkRef.current.disconnect(); } catch (e) {}
    recorderSinkRef.current = null;
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    micTrackRef.current = null;
    window.__dawPianoDestination = null;
  };

  const stopPlayback = () => {
    Object.values(trackSourcesRef.current).forEach(ts => {
      try {
        if (ts.source) ts.source.stop();
        if (ts.source) ts.source.disconnect();
        if (ts.gainNode) ts.gainNode.disconnect();
      } catch (e) {}
    });
    trackSourcesRef.current = {};
    transportStartTimeRef.current = 0;
    cancelAnimationFrame(playheadRafRef.current);
    setIsPlaying(false);
    setIsRecording(false);
    setPlayhead(0);
  };

  const startPlayback = (recordMode = false) => {
    initAudio();
    stopPlayback(); // stop any existing

    setIsPlaying(true);
    setIsRecording(recordMode);

    // While recording, the transport downbeat (T0) sits a pre-roll ahead so the
    // recorder worklet is already capturing before it — this is what makes the
    // recorded take's position on the timeline sample-accurate. Plain playback
    // starts immediately.
    const now = audioCtxRef.current.currentTime;
    const startAt = recordMode ? now + RECORD_PREROLL_SEC : now;
    startTimeRef.current = startAt;
    transportStartTimeRef.current = startAt;
    if (recordMode) setRecordingStartTime(startAt);

    const anySolo = tracks.some(t => t.isSoloed);

    tracks.forEach(track => {
      if (track.audioBuffer && !(recordMode && track.isArmed)) {
        const source = audioCtxRef.current.createBufferSource();
        source.buffer = track.audioBuffer;

        const gainNode = audioCtxRef.current.createGain();
        let effectiveVol = track.volume;
        if (track.isMuted) effectiveVol = 0;
        if (anySolo && !track.isSoloed) effectiveVol = 0;
        gainNode.gain.value = effectiveVol;

        source.connect(gainNode);
        gainNode.connect(masterGainRef.current);
        source.start(startAt);

        trackSourcesRef.current[track.id] = { source, gainNode };
      }
    });

    const updatePlayhead = () => {
      // Clamp so the playhead sits at 0 during the pre-roll rather than going negative.
      const current = Math.max(0, audioCtxRef.current.currentTime - startTimeRef.current);
      setPlayhead(current);
      playheadRafRef.current = requestAnimationFrame(updatePlayhead);
    };
    playheadRafRef.current = requestAnimationFrame(updatePlayhead);
  };

  const handlePlay = () => {
    if (isPlaying) {
      stopPlayback();
    } else {
      startPlayback(false);
    }
  };

  const handleRecord = async () => {
    if (isRecording) {
      handleStop();
      return;
    }
    initAudio();

    const armedTrack = tracks.find(t => t.isArmed);
    if (!armedTrack) {
      alert("Please arm a track to record.");
      return;
    }

    const ctx = audioCtxRef.current;
    const inputType = armedTrack.inputType || 'both';

    // Piano notes are routed here (recorder input 1) via PianoPanel's __dawPianoDestination.
    const dawPianoDest = ctx.createGain();
    window.__dawPianoDestination = dawPianoDest;

    try {
      await ensureRecorderLoaded(ctx);
    } catch (err) {
      console.error("Failed to load recorder worklet:", err);
      alert("Failed to start recording.");
      window.__dawPianoDestination = null;
      return;
    }

    const recorder = createRecorder(ctx);
    recorderRef.current = recorder;

    // Silent sink: keeps the browser continuously pulling the recorder worklet even
    // when the only connected source is the intermittent piano bus. Emits no audio.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    recorder.node.connect(sink);
    sink.connect(masterGainRef.current);
    recorderSinkRef.current = sink;

    let hasAudioInput = false;
    micTrackRef.current = null;

    // Mic → recorder input 0
    if (inputType === 'mic' || inputType === 'both') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(LOW_LATENCY_MIC_CONSTRAINTS);
        micStreamRef.current = stream;
        const micSource = ctx.createMediaStreamSource(stream);
        micSource.connect(recorder.node, 0, RECORDER_MIC_INPUT);
        micTrackRef.current = stream.getAudioTracks()[0] || null;
        hasAudioInput = true;
      } catch (err) {
        console.warn("Microphone access unavailable or denied:", err);
        if (inputType === 'mic') {
          alert("Microphone access is required for Microphone track recording.");
          teardownRecordingGraph();
          return;
        }
      }
    }

    // Piano → recorder input 1
    if (inputType === 'piano' || inputType === 'both') {
      dawPianoDest.connect(recorder.node, 0, RECORDER_PIANO_INPUT);
      hasAudioInput = true;
    }

    if (!hasAudioInput) {
      alert("No audio source available for recording.");
      teardownRecordingGraph();
      return;
    }

    // Snapshot the live latency figures for this take (used for per-source compensation).
    latenciesRef.current = measureLatencies(ctx, micTrackRef.current);

    // The recorder is already capturing (pre-roll). Start the transport at
    // T0 = now + RECORD_PREROLL_SEC; the worklet reports the exact frame it began so
    // buildTrackBuffer() can align the take to T0 with sample accuracy.
    startPlayback(true);
  };

  const handleStop = async () => {
    const recorder = recorderRef.current;
    const armedInputType = (tracks.find(t => t.isArmed)?.inputType) || 'both';
    const transportStartTime = transportStartTimeRef.current;
    const latencies = latenciesRef.current;

    stopPlayback();

    if (!recorder) {
      teardownRecordingGraph();
      return;
    }

    // Flush the worklet ring buffers and build the aligned take.
    let result = null;
    try {
      result = await recorder.stop();
    } catch (e) {
      console.error("Recorder flush failed:", e);
    }
    teardownRecordingGraph();

    if (result && result.samples > 0 && audioCtxRef.current) {
      const audioBuffer = buildTrackBuffer({
        ctx: audioCtxRef.current,
        micPcm: result.micPcm,
        pianoPcm: result.pianoPcm,
        startFrame: result.startFrame,
        sampleRate: result.sampleRate,
        transportStartTime,
        latencies,
        userTrimMs: latencyTrimMs,
        pianoTrimMs,
        inputType: armedInputType,
      });
      if (audioBuffer) {
        setTracks(prev => prev.map(t => (
          t.isArmed ? { ...t, audioBuffer, duration: audioBuffer.duration } : t
        )));
      }
    }
  };

  const toggleTrackProperty = (trackId, prop) => {
    setTracks(prev => prev.map(t => {
      if (t.id === trackId) {
        return { ...t, [prop]: !t[prop] };
      }
      if (prop === 'isArmed' && t.id !== trackId) {
        return { ...t, isArmed: false };
      }
      if (prop === 'isSoloed' && t.id !== trackId) {
        return { ...t, isSoloed: false };
      }
      return t;
    }));
  };

  const updateTrackInputType = (trackId, type) => {
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, inputType: type } : t));
  };

  const updateTrackVolume = (trackId, vol) => {
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, volume: vol } : t));
  };

  const deleteTrack = (trackId) => {
    if (trackSourcesRef.current[trackId]) {
      try {
        if (trackSourcesRef.current[trackId].source) trackSourcesRef.current[trackId].source.stop();
        if (trackSourcesRef.current[trackId].source) trackSourcesRef.current[trackId].source.disconnect();
        if (trackSourcesRef.current[trackId].gainNode) trackSourcesRef.current[trackId].gainNode.disconnect();
      } catch (e) {}
      delete trackSourcesRef.current[trackId];
    }
    setTracks(prev => prev.filter(t => t.id !== trackId));
  };

  const addTrackWithType = (inputType = 'both') => {
    const labels = { mic: 'Vocal Mic', piano: 'Grand Piano', both: 'Mic & Piano' };
    const count = tracks.length + 1;
    setTracks(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        name: `Track ${count} (${labels[inputType] || 'Audio'})`,
        inputType,
        audioBuffer: null,
        volume: 0.8,
        isMuted: false,
        isSoloed: false,
        isArmed: false,
        duration: 0
      }
    ]);
    setShowAddMenu(false);
  };

  // Timeline Grid Mathematics
  const pixelsPerBeat = 40;
  const pixelsPerMeasure = pixelsPerBeat * beatsPerMeasure;
  const secondsPerBeat = 60 / bpm;
  const pixelsPerSecond = (pixelsPerBeat * bpm) / 60;
  const totalMeasures = 32;

  const getInputBadge = (type) => {
    switch (type) {
      case 'piano': return { icon: '🎹', label: 'Piano' };
      case 'mic': return { icon: '🎤', label: 'Mic' };
      case 'both': default: return { icon: '🎙️🎹', label: 'Both' };
    }
  };

  return (
    <div className={styles.dawPanel} style={{ width: `${panelWidth}px` }}>
      {/* Left Resize Drag Handle */}
      <div
        className={`${styles.resizeHandle} ${isResizing ? styles.resizingActive : ''}`}
        onMouseDown={startResizing}
        title="Drag to resize DAW panel width"
      />

      {/* Transport Header */}
      <div className={styles.transportBar}>
        {/* Row 1: Actions, Playback, Sub-Toggles and Track management */}
        <div className={styles.transportRow}>
          <div className={styles.titleWithHelp}>
            <span className={styles.panelTitle}>Scratchpad</span>
            <button
              className={styles.helpBtn}
              onClick={() => setShowHelpModal(true)}
              title="How Scratchpad Works"
              id="scratchpad-help-btn"
            >
              💡 Help
            </button>
          </div>

          {(onToggleDaw || onTogglePiano) && (
            <div className={styles.subToggleGroup}>
              {onToggleDaw && (
                <button
                  className={`${styles.subToggleBtn} ${showDaw ? styles.subToggleActive : ''}`}
                  onClick={onToggleDaw}
                  title={showDaw ? 'Hide DAW Tracks' : 'Show DAW Tracks'}
                  id="scratchpad-toggle-daw-btn"
                >
                  🎙️ DAW {showDaw ? 'ON' : 'OFF'}
                </button>
              )}
              {onTogglePiano && (
                <button
                  className={`${styles.subToggleBtn} ${showPiano ? styles.subToggleActive : ''}`}
                  onClick={onTogglePiano}
                  title={showPiano ? 'Hide Piano Keyboard' : 'Show Piano Keyboard'}
                  id="scratchpad-toggle-piano-btn"
                >
                  🎹 Piano {showPiano ? 'ON' : 'OFF'}
                </button>
              )}
            </div>
          )}

          <div className={styles.playbackControls}>
            <button className={`${styles.transBtn} ${isPlaying && !isRecording ? styles.activePlay : ''}`} onClick={handlePlay} title="Play">
              ▶ Play
            </button>
            <button className={styles.transBtn} onClick={handleStop} title="Stop">
              ■ Stop
            </button>
            <button className={`${styles.transBtn} ${isRecording ? styles.activeRecord : ''}`} onClick={handleRecord} title="Record">
              ● Rec
            </button>
          </div>

          {showDaw && (
            <div className={styles.actionButtonsGroup}>
              <div className={styles.addTrackWrapper}>
                <button className={styles.addTrackBtn} onClick={() => setShowAddMenu(!showAddMenu)}>
                  + Add Track ▼
                </button>
                {showAddMenu && (
                  <div className={styles.addTrackMenu}>
                    <button onClick={() => addTrackWithType('mic')}>🎤 Microphone Track</button>
                    <button onClick={() => addTrackWithType('piano')}>🎹 Piano Track</button>
                    <button onClick={() => addTrackWithType('both')}>🎙️🎹 Mic & Piano Track</button>
                  </div>
                )}
              </div>

              {/* Audio Export Dropdown */}
              <div className={styles.exportAudioWrapper} ref={exportAudioRef}>
                <button
                  className={`${styles.exportAudioBtn} ${hasRecordedAudio ? styles.hasAudio : ''}`}
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  title="Export recorded audio (.wav / .mp3)"
                  id="export-audio-btn"
                >
                  💾 Export Audio ▼
                </button>
                {showExportMenu && (
                  <div className={styles.exportAudioMenu} role="menu">
                    <div className={styles.exportMenuTitle}>Master Mix (All Tracks)</div>
                    <button
                      className={styles.exportMenuItem}
                      onClick={() => handleExportMaster('wav')}
                      disabled={!hasRecordedAudio}
                      id="export-master-wav-btn"
                    >
                      🎵 Master Mix (.wav)
                    </button>
                    <button
                      className={styles.exportMenuItem}
                      onClick={() => handleExportMaster('mp3')}
                      disabled={!hasRecordedAudio}
                      id="export-master-mp3-btn"
                    >
                      🎵 Master Mix (.mp3)
                    </button>

                    {tracksWithAudio.length > 0 && (
                      <>
                        <div className={styles.exportMenuDivider} />
                        <div className={styles.exportMenuTitle}>Individual Tracks</div>
                        {tracksWithAudio.map(t => (
                          <div key={t.id} className={styles.trackExportRow}>
                            <span className={styles.trackExportName} title={t.name}>{t.name}</span>
                            <div className={styles.trackFormatBtns}>
                              <button onClick={() => handleExportSingleTrack(t, 'wav')} title={`Export ${t.name} as .wav`}>
                                .wav
                              </button>
                              <button onClick={() => handleExportSingleTrack(t, 'mp3')} title={`Export ${t.name} as .mp3`}>
                                .mp3
                              </button>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Row 2: Settings, Metronome & Volume */}
        <div className={`${styles.transportRow} ${styles.settingsRow}`}>
          {/* Metronome Box */}
          <div className={styles.metroBoxCompact}>
            <button
              className={`${styles.metroToggleBtnCompact} ${isMetroOn ? styles.metroToggleActiveCompact : ''}`}
              onClick={handleToggleMetro}
              title="Toggle Metronome"
            >
              🔔 Metro {isMetroOn ? 'ON' : 'OFF'}
            </button>
              <div className={styles.metroConfigRowCompact}>
                <span className={styles.configLabelCompact}>BPM:</span>
                <input
                  type="number"
                  min="40"
                  max="240"
                  value={bpmInput}
                  onChange={handleBpmChange}
                  onBlur={handleBpmBlur}
                  className={styles.bpmInputCompact}
                  title="Metronome BPM (40-240)"
                />
                <select
                  value={beatsPerMeasure}
                  onChange={e => setBeatsPerMeasure(parseInt(e.target.value, 10))}
                  className={styles.timeSigSelectCompact}
                  aria-label="Time signature beats per measure"
                >
                  <option value="2">2/4</option>
                  <option value="3">3/4</option>
                  <option value="4">4/4</option>
                  <option value="6">6/8</option>
                </select>
              </div>
            </div>

            <div className={styles.slidersGroup}>
              {/* Master Volume */}
              <div className={styles.masterVolContainer}>
                <span className={styles.sliderLabel}>Master</span>
                <input
                  type="range"
                  min="0" max="1" step="0.05"
                  value={masterVolume}
                  onChange={e => setMasterVolume(parseFloat(e.target.value))}
                  className={styles.volSlider}
                  title="Master Volume"
                />
              </div>

              {/* Voice latency trim */}
              <div className={styles.latencyTrimContainer}>
                <span className={styles.latencyTrimLabel} title="Voice/mic recording latency trim">🎤 Trim</span>
                <input
                  type="range"
                  min="-10" max="40" step="1"
                  value={latencyTrimMs}
                  onChange={e => setLatencyTrimMs(parseInt(e.target.value, 10))}
                  className={styles.latencyTrimSlider}
                  title={`Voice latency trim: ${latencyTrimMs}ms`}
                />
                <span className={styles.latencyTrimValue}>{latencyTrimMs}ms</span>
                <button
                  className={styles.helpBtn}
                  onClick={() => setShowLatencyHelper(true)}
                  title="Re-run the latency calibration helper"
                  id="scratchpad-calibrate-latency-btn"
                >
                  🎯
                </button>
              </div>

              {/* Piano latency trim — nudge piano takes to line up with vocals.
                  Lower = piano later (it usually sits ahead of the mic). */}
              <div className={styles.latencyTrimContainer}>
                <span className={styles.latencyTrimLabel} title="Piano recording latency trim">🎹 Trim</span>
                <input
                  type="range"
                  min="-50" max="40" step="1"
                  value={pianoTrimMs}
                  onChange={e => setPianoTrimMs(parseInt(e.target.value, 10))}
                  className={styles.latencyTrimSlider}
                  title={`Piano latency trim: ${pianoTrimMs}ms (lower = piano later)`}
                  id="scratchpad-piano-trim-slider"
                />
                <span className={styles.latencyTrimValue}>{pianoTrimMs}ms</span>
              </div>
            </div>
          </div>
      </div>

      {/* Unified Horizontal Timeline & Tracks Area */}
      {showDaw && (
        <div className={styles.timelineArea}>
          <div className={styles.timelineScrollContainer}>
            {/* Timeline Ruler Header */}
            <div className={styles.timeRuler}>
              <div className={styles.rulerCorner}>Track Controls</div>
              <div className={styles.rulerTrackArea}>
                {Array.from({ length: totalMeasures }).map((_, m) => (
                  <div
                    key={m}
                    className={styles.barMarker}
                    style={{ width: `${pixelsPerMeasure}px` }}
                  >
                    <span className={styles.barLabel}>Bar {m + 1}</span>
                    <div className={styles.beatTicks}>
                      {Array.from({ length: beatsPerMeasure }).map((_, b) => (
                        <div
                          key={b}
                          className={`${styles.beatTick} ${b === 0 ? styles.beatTickMeasure : ''}`}
                          style={{ left: `${(b / beatsPerMeasure) * 100}%` }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div className={styles.playhead} style={{ left: `${playhead * pixelsPerSecond}px` }}>
                  <div className={styles.playheadTriangle} />
                </div>
              </div>
            </div>

            {/* Flexible Tracks List Container */}
            <div className={styles.tracksListContainer}>
              {tracks.map(track => {
                const inputBadge = getInputBadge(track.inputType);
                const currentHeight = trackHeights[track.id] || 68;
                return (
                  <div
                    key={track.id}
                    className={`${styles.trackRow} ${track.isArmed ? styles.activeTrack : ''}`}
                    style={{ height: `${currentHeight}px` }}
                  >
                    {/* Sticky Track Control Header */}
                    <div className={styles.trackHeader}>
                      <div className={styles.trackNameRow}>
                        <span className={styles.trackName} title={track.name}>{track.name}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                          {track.audioBuffer && (
                            <button
                              className={styles.downloadTrackBtn}
                              onClick={() => handleExportSingleTrack(track, 'wav')}
                              title={`Download ${track.name} audio (.wav)`}
                            >
                              💾
                            </button>
                          )}
                          <button
                            className={styles.deleteTrackBtn}
                            onClick={() => deleteTrack(track.id)}
                            title="Delete Track"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      <div className={styles.trackControls}>
                        <select
                          className={styles.inputTypeSelect}
                          value={track.inputType || 'both'}
                          onChange={(e) => updateTrackInputType(track.id, e.target.value)}
                          title="Select audio input source for this track"
                        >
                          <option value="mic">🎤 Mic</option>
                          <option value="piano">🎹 Piano</option>
                          <option value="both">🎙️🎹 Both</option>
                        </select>
                        <div className={styles.buttonGroup}>
                          <button
                            className={`${styles.trackBtn} ${styles.btnMute} ${track.isMuted ? styles.active : ''}`}
                            onClick={() => toggleTrackProperty(track.id, 'isMuted')}
                            title="Mute Track"
                          >
                            M
                          </button>
                          <button
                            className={`${styles.trackBtn} ${styles.btnSolo} ${track.isSoloed ? styles.active : ''}`}
                            onClick={() => toggleTrackProperty(track.id, 'isSoloed')}
                            title="Solo Track"
                          >
                            S
                          </button>
                          <button
                            className={`${styles.trackBtn} ${styles.btnArm} ${track.isArmed ? styles.active : ''}`}
                            onClick={() => toggleTrackProperty(track.id, 'isArmed')}
                            title="Arm Track for Recording"
                          >
                            ●
                          </button>
                        </div>
                      </div>

                      <div className={styles.trackVolRow}>
                        <input
                          type="range"
                          min="0" max="1" step="0.05"
                          value={track.volume}
                          onChange={e => updateTrackVolume(track.id, parseFloat(e.target.value))}
                          className={styles.volSlider}
                          style={{ width: '100%' }}
                          title="Track Volume"
                        />
                      </div>
                    </div>

                    {/* Track Lane with Grid Lines & Waveforms */}
                    <div className={styles.trackLane}>
                      <div className={styles.gridLinesContainer}>
                        {Array.from({ length: totalMeasures }).map((_, m) => (
                          <div
                            key={m}
                            className={styles.gridMeasureLine}
                            style={{ width: `${pixelsPerMeasure}px` }}
                          >
                            {Array.from({ length: beatsPerMeasure }).map((_, b) => (
                              <div
                                key={b}
                                className={`${styles.gridBeatLine} ${b === 0 ? styles.gridBeatLineFirst : ''}`}
                                style={{ left: `${(b / beatsPerMeasure) * 100}%` }}
                              />
                            ))}
                          </div>
                        ))}
                      </div>

                      {track.audioBuffer && (
                        <div
                          className={styles.clipBlock}
                          style={{ left: 0, width: `${Math.max(40, track.duration * pixelsPerSecond)}px` }}
                        >
                          <WaveformCanvas
                            audioBuffer={track.audioBuffer}
                            width={Math.max(40, track.duration * pixelsPerSecond)}
                            height={Math.max(20, currentHeight - 22)}
                            isRecording={false}
                          />
                        </div>
                      )}
                      {isRecording && track.isArmed && (
                        <div
                          className={`${styles.clipBlock} ${styles.recording}`}
                          style={{ left: 0, width: `${Math.max(40, playhead * pixelsPerSecond)}px` }}
                        >
                          <WaveformCanvas
                            audioBuffer={null}
                            width={Math.max(40, playhead * pixelsPerSecond)}
                            height={Math.max(20, currentHeight - 22)}
                            isRecording={true}
                          />
                        </div>
                      )}
                    </div>

                    {/* Bottom horizontal resizer handle */}
                    <div
                      className={styles.trackResizeHandle}
                      onMouseDown={(e) => startTrackResize(track.id, e)}
                      title="Drag to resize track height"
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Embedded Piano keyboard under the tracks */}
      {showPiano && <PianoPanel embedded />}

      {/* Empty State when both DAW and Piano are hidden */}
      {!showDaw && !showPiano && (
        <div className={styles.scratchpadEmptyState}>
          🎹 Scratchpad tools hidden. Click 🎙️ DAW or 🎹 Piano above to show tools.
        </div>
      )}

      {/* Help Modal */}
      {showHelpModal && (
        <div className={styles.modalOverlay} onClick={() => setShowHelpModal(false)}>
          <div className={styles.helpModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>❓ Scratchpad Guide</h3>
              <button className={styles.closeModalBtn} onClick={() => setShowHelpModal(false)}>✕</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.helpSection}>
                <h4>🎛️ Track Input Types & Width</h4>
                <ul>
                  <li><strong>🎤 Mic:</strong> Records audio from your microphone.</li>
                  <li><strong>🎹 Piano:</strong> Records notes played on the Playable Piano (mouse or computer keyboard) directly into the track.</li>
                  <li><strong>🎙️🎹 Both:</strong> Records microphone audio AND piano notes mixed together.</li>
                  <li><strong>Resize / Expand:</strong> Drag the left border of DAW Studio or click <strong>⇹ Expand</strong> to widen the studio panel for comfortable editing!</li>
                </ul>
              </div>
              <div className={styles.helpSection}>
                <h4>⏱️ Timeline Grid & Waveforms</h4>
                <ul>
                  <li><strong>Horizontal Scroll:</strong> Scroll horizontally to view bars & measures across the timeline. Track controls stay locked on the left.</li>
                  <li><strong>Audio Waveforms:</strong> Recorded audio displays detailed peak waveforms. Active recording renders animated live signal waves.</li>
                  <li><strong>BPM & Metronome:</strong> Adjust tempo (40–240 BPM) and time signature (2/4, 3/4, 4/4, 6/8). Turning ON DAW metronome stops Piano metronome.</li>
                </ul>
              </div>
              <div className={styles.helpSection}>
                <h4>🔴 Recording & Controls</h4>
                <ul>
                  <li><strong>Arm Track (●):</strong> Click ● on a track header to arm it for recording.</li>
                  <li><strong>Record (● Transport):</strong> Begins recording into the armed track according to its selected input type.</li>
                  <li><strong>Track Management:</strong> Use <strong>+ Add Track ▼</strong> to add new tracks and <strong>🗑️</strong> to delete tracks.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Latency Trim Helper — first-run (or manually re-opened) calibration popup */}
      {showLatencyHelper && (
        <LatencyTrimHelper
          initialTrimMs={latencyTrimMs}
          onSave={(ms) => {
            setLatencyTrimMs(ms);
            setShowLatencyHelper(false);
          }}
          onClose={() => setShowLatencyHelper(false)}
        />
      )}
    </div>
  );
}
