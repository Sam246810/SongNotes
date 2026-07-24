import { useState, useRef, useEffect } from 'react';
import styles from './DAWPanel.module.css';
import { getSharedAudioContext } from '../../utils/audioContext';
import { audioBufferToWav, audioBufferToMp3, mixTracksToMasterBuffer, downloadAudioBlob, sanitizeAudioFilename } from '../../utils/audioExport';
import { getStoredLatencyTrimMs, setStoredLatencyTrimMs, getStoredPianoTrimMs, setStoredPianoTrimMs, hasSeenLatencyTrimHelper } from '../../utils/latencyTrimSettings';
import useDawSession from '../../audio/dawSession';
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
import { computeAudibleSegments, renderTrackClips, insertClipNonOverlapping, clipDuration, MIN_CLIP_DURATION_SEC } from '../../audio/clipEngine';
import PianoPanel from '../PianoPanel/PianoPanel';
import LatencyTrimHelper from '../LatencyTrimHelper/LatencyTrimHelper';

/**
 * WaveformCanvas Component — Renders peak waveform shapes for audio buffers
 * or dynamic animated pulse waves during active recording.
 */
function WaveformCanvas({ audioBuffer, trimStart = 0, trimEnd = 0, width, height, isRecording }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    // .clipBlock's background is a theme-accent-tinted overlay (see DAWPanel.module.css),
    // not a fixed near-black surface — reading the live theme vars here (rather than a
    // hardcoded white/red) keeps the waveform visible in both light and dark mode.
    const themeColor = (varName) => getComputedStyle(canvas).getPropertyValue(varName).trim();

    ctx.clearRect(0, 0, w, h);

    if (audioBuffer) {
      const data = audioBuffer.getChannelData(0);
      const sr = audioBuffer.sampleRate;
      // Only draw the trimmed (audible) slice — the clip block's width already
      // represents the post-trim duration, so the waveform must match it 1:1.
      const startSample = Math.max(0, Math.floor(trimStart * sr));
      const endSample = Math.min(data.length, Math.max(startSample + 1, data.length - Math.floor(trimEnd * sr)));
      const visibleLen = endSample - startSample;
      const step = Math.ceil(visibleLen / Math.max(1, w));
      const amp = h / 2;

      ctx.fillStyle = themeColor('--text-primary') || 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();

      for (let i = 0; i < w; i++) {
        let min = 1.0;
        let max = -1.0;
        for (let j = 0; j < step; j++) {
          const idx = startSample + i * step + j;
          const datum = idx < endSample ? data[idx] : undefined;
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
        ctx.strokeStyle = themeColor('--danger') || '#ef4444';
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
  }, [audioBuffer, trimStart, trimEnd, width, height, isRecording]);

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

/** The startup tracks for a song that's never had anything recorded/imported yet. */
function makeDefaultTracks() {
  return [
    { id: '1', name: 'Vocals', inputType: 'mic', clips: [], volume: 0.8, isMuted: false, isSoloed: false, isArmed: true },
    { id: '2', name: 'Grand Piano', inputType: 'piano', clips: [], volume: 0.8, isMuted: false, isSoloed: false, isArmed: false },
  ];
}

export default function DAWPanel({ songId, showPiano, onTogglePiano, showDaw, onToggleDaw }) {
  // Hydrate from this song's in-memory session tracks (if any were recorded/imported
  // earlier this session), falling back to the defaults for a song seen for the first
  // time — or when songId is falsy (e.g. no active song), which never touches the store.
  const [tracks, setTracks] = useState(
    () => useDawSession.getState().getTracks(songId) ?? makeDefaultTracks()
  );

  // Write every change straight back to the session store, keyed by song. Since
  // Editor.jsx remounts DAWPanel with key={song.id} on song switch, this keeps the
  // store current before the old instance ever unmounts — no unmount-time flush needed.
  useEffect(() => {
    useDawSession.getState().saveTracks(songId, tracks);
  }, [songId, tracks]);

  // Whether this song has recorded/imported audio that hasn't been exported yet.
  const dawDirty = useDawSession((s) => !!(songId && s.dirtyBySong[songId]));

  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [playhead, setPlayhead] = useState(0); // in seconds
  const [masterVolume, setMasterVolume] = useState(0.8);
  const [recordingStartTime, setRecordingStartTime] = useState(0);

  // DAW Metronome state
  const [bpm, setBpm] = useState(120);
  const [bpmInput, setBpmInput] = useState('120');
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);

  // Timeline Grid Mathematics — declared early since click-to-seek and clip
  // move/trim handlers below need pixelsPerSecond in scope.
  const [zoom, setZoom] = useState(1); // Ctrl/Cmd+scroll over the timeline adjusts this
  const BASE_PIXELS_PER_BEAT = 40;
  const pixelsPerBeat = BASE_PIXELS_PER_BEAT * zoom;
  const pixelsPerMeasure = pixelsPerBeat * beatsPerMeasure;
  const secondsPerBeat = 60 / bpm;
  const pixelsPerSecond = (pixelsPerBeat * bpm) / 60;
  const totalMeasures = 32;
  // Only legible once beats are wide enough apart to hold a small label.
  const showBeatLabels = pixelsPerBeat >= 60;

  const [isMetroOn, setIsMetroOn] = useState(false);
  const [currentBeat, setCurrentBeat] = useState(-1);
  // Audible one-bar count-in (4 beats by default, or however many the time signature
  // has) that always plays before a take actually starts capturing — separate from the
  // isMetroOn toggle above, which is the free-standing click track.
  const [isCountingIn, setIsCountingIn] = useState(false);
  const [countInBeat, setCountInBeat] = useState(-1);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const exportAudioRef = useRef(null);
  const importInputRef = useRef(null);

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

  const hasRecordedAudio = tracks.some(t => t.clips.length > 0);
  const tracksWithAudio = tracks.filter(t => t.clips.length > 0);

  const handleExportMaster = async (format) => {
    // Flatten each track's clips (trims + overlap already resolved) into one buffer,
    // then reuse the existing multi-track mixer unchanged.
    const flatTracks = tracks
      .map(t => ({ ...t, audioBuffer: renderTrackClips(audioCtxRef.current, t.clips) }))
      .filter(t => t.audioBuffer);
    const master = mixTracksToMasterBuffer(flatTracks, audioCtxRef.current);
    if (!master) {
      alert("No recorded audio tracks available to export.");
      return;
    }
    const blob = format === 'mp3' ? await audioBufferToMp3(master) : audioBufferToWav(master);
    const filename = `${sanitizeAudioFilename('Master_Mix')}.${format}`;
    downloadAudioBlob(blob, filename);
    // Exporting the full master mix is the "I saved everything" gesture — clears the
    // unexported-audio nudge. A single-track export intentionally does NOT clear it,
    // since it's safer to keep warning than risk losing other tracks.
    useDawSession.getState().markExported(songId);
    setShowExportMenu(false);
  };

  const handleExportSingleTrack = async (track, format) => {
    const flat = renderTrackClips(audioCtxRef.current, track.clips);
    if (!flat) return;
    const blob = format === 'mp3' ? await audioBufferToMp3(flat) : audioBufferToWav(flat);
    const filename = `${sanitizeAudioFilename(track.name)}.${format}`;
    downloadAudioBlob(blob, filename);
    setShowExportMenu(false);
  };

  function makeImportedTrack(name, audioBuffer) {
    return {
      id: crypto.randomUUID(),
      name,
      inputType: 'mic',
      clips: [{ id: crypto.randomUUID(), startTime: 0, buffer: audioBuffer, trimStart: 0, trimEnd: 0 }],
      volume: 0.8,
      isMuted: false,
      isSoloed: false,
      isArmed: false,
    };
  }

  // Bring a previously-exported (or any) audio file back in as a new track — the
  // manual re-import half of the export nudge, since recorded audio never persists
  // across a reload on its own. Our own "mp3" export is really WAV bytes under a
  // different extension, so decodeAudioData handles a round-tripped file either way.
  const handleImportFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-importing the same file again later
    if (!files.length) return;

    initAudio();
    const ctx = audioCtxRef.current;

    for (const file of files) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const name = file.name.replace(/\.[^./\\]+$/, '') || 'Imported Track';
        setTracks((prev) => [...prev, makeImportedTrack(name, audioBuffer)]);
      } catch (err) {
        console.error('Failed to import audio file:', err);
        alert(`Couldn't import "${file.name}". Make sure it's a valid audio file.`);
      }
    }
    useDawSession.getState().markDirty(songId);
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

  // Clip move + trim (drag the body to reposition, drag an edge to trim) — mirrors
  // startTrackResize's pattern above: mousedown captures the starting pointer position
  // and the clip's original numbers, a window-level mousemove/mouseup pair does the
  // live drag. Blocked while the transport is running so an edit can't fight playback.
  const [clipDrag, setClipDrag] = useState(null); // { trackId, clipId, mode, startX, orig, bufferDuration }

  const startClipMove = (trackId, clip, e) => {
    if (e.ctrlKey || e.metaKey) return; // let it bubble up to the timeline's pan-drag instead
    e.stopPropagation();
    if (isPlaying || isRecording) return;
    const track = tracks.find(t => t.id === trackId);
    const dur = clipDuration(clip);
    // Clips never overlap, so a move is bounded by whatever's immediately before/after
    // it on the track today — the tightest end-of-previous and start-of-next among the
    // others, found by scanning rather than assuming any particular sort order.
    let minStart = 0;
    let maxStart = Infinity;
    track.clips.forEach(o => {
      if (o.id === clip.id) return;
      const oEnd = o.startTime + clipDuration(o);
      if (oEnd <= clip.startTime + 1e-9 && oEnd > minStart) minStart = oEnd;
      if (o.startTime >= clip.startTime + dur - 1e-9 && o.startTime - dur < maxStart) maxStart = o.startTime - dur;
    });

    setClipDrag({
      trackId, clipId: clip.id, mode: 'move', startX: e.clientX,
      orig: { startTime: clip.startTime, trimStart: clip.trimStart, trimEnd: clip.trimEnd },
      bufferDuration: clip.buffer.duration,
      minStart, maxStart,
    });
  };

  const startClipTrim = (trackId, clip, edge, e) => {
    if (e.ctrlKey || e.metaKey) return; // let it bubble up to the timeline's pan-drag instead
    e.stopPropagation();
    if (isPlaying || isRecording) return;
    const track = tracks.find(t => t.id === trackId);
    const dur = clipDuration(clip);
    // Same idea as the move bounds above: how far this edge can be dragged to reclaim
    // trimmed material is capped by the neighbor it would otherwise start overlapping.
    let prevEnd = 0;
    let nextStart = Infinity;
    track.clips.forEach(o => {
      if (o.id === clip.id) return;
      const oEnd = o.startTime + clipDuration(o);
      if (oEnd <= clip.startTime + 1e-9 && oEnd > prevEnd) prevEnd = oEnd;
      if (o.startTime >= clip.startTime + dur - 1e-9 && o.startTime < nextStart) nextStart = o.startTime;
    });

    setClipDrag({
      trackId, clipId: clip.id, mode: edge === 'start' ? 'trimStart' : 'trimEnd', startX: e.clientX,
      orig: { startTime: clip.startTime, trimStart: clip.trimStart, trimEnd: clip.trimEnd },
      bufferDuration: clip.buffer.duration,
      prevEnd, nextStart,
    });
  };

  useEffect(() => {
    if (!clipDrag) return;

    const el = timelineAreaRef.current;
    const corner = el ? el.querySelector('[class*="rulerCorner"]') : null;
    let lastClientX = clipDrag.startX;
    // How much the timeline has auto-scrolled since the drag began, in the same units
    // as clientX (px) — folded into the delta below so dragging a clip's edge past the
    // visible edge keeps extending it even while the mouse itself isn't moving.
    let autoScrollAccumPx = 0;

    const EDGE_ZONE_PX = 50; // distance from the visible edge that triggers auto-scroll
    const MAX_SCROLL_SPEED_PX = 18; // per animation frame, at full edge penetration

    function applyDrag(clientX) {
      const deltaSec = ((clientX - clipDrag.startX) + autoScrollAccumPx) / pixelsPerSecond;
      setTracks(prev => prev.map(t => {
        if (t.id !== clipDrag.trackId) return t;
        return {
          ...t,
          clips: t.clips.map(c => {
            if (c.id !== clipDrag.clipId) return c;
            if (clipDrag.mode === 'move') {
              const target = clipDrag.orig.startTime + deltaSec;
              const clamped = Math.min(clipDrag.maxStart, Math.max(clipDrag.minStart, target));
              return { ...c, startTime: clamped };
            }
            if (clipDrag.mode === 'trimStart') {
              // Left edge: dragging right eats more of the buffer's head (trimStart
              // grows) and the clip's start slides with it; the right edge — where
              // the clip ends — stays put, exactly like trimming in a real DAW. Can't
              // reclaim past where the previous clip on this track ends.
              const maxTrimStart = clipDrag.bufferDuration - clipDrag.orig.trimEnd - MIN_CLIP_DURATION_SEC;
              let newTrimStart = Math.min(maxTrimStart, Math.max(0, clipDrag.orig.trimStart + deltaSec));
              let newStart = Math.max(0, clipDrag.orig.startTime + (newTrimStart - clipDrag.orig.trimStart));
              if (newStart < clipDrag.prevEnd) {
                newStart = clipDrag.prevEnd;
                newTrimStart = clipDrag.orig.trimStart + (newStart - clipDrag.orig.startTime);
              }
              return { ...c, trimStart: newTrimStart, startTime: newStart };
            }
            if (clipDrag.mode === 'trimEnd') {
              // Right edge: dragging left eats more of the buffer's tail (trimEnd
              // grows); the start position is untouched. Can't reclaim past where the
              // next clip on this track starts.
              const maxTrimEnd = clipDrag.bufferDuration - clipDrag.orig.trimStart - MIN_CLIP_DURATION_SEC;
              let newTrimEnd = Math.min(maxTrimEnd, Math.max(0, clipDrag.orig.trimEnd - deltaSec));
              if (Number.isFinite(clipDrag.nextStart)) {
                const newEnd = clipDrag.orig.startTime + (clipDrag.bufferDuration - clipDrag.orig.trimStart - newTrimEnd);
                if (newEnd > clipDrag.nextStart) {
                  newTrimEnd = clipDrag.bufferDuration - clipDrag.orig.trimStart - (clipDrag.nextStart - clipDrag.orig.startTime);
                }
              }
              return { ...c, trimEnd: newTrimEnd };
            }
            return c;
          }),
        };
      }));
    }

    const handleMouseMove = (e) => {
      lastClientX = e.clientX;
      applyDrag(lastClientX);
    };

    const handleMouseUp = () => setClipDrag(null);

    // While dragging a clip's edge (or body) past the visible timeline, keep scrolling
    // it sideways so the point being dragged to stays in view — same idea as dragging a
    // file near the edge of a scrollable list.
    let rafId;
    function autoScrollTick() {
      if (el) {
        const leftEdge = corner ? corner.getBoundingClientRect().right : el.getBoundingClientRect().left;
        const rightEdge = el.getBoundingClientRect().right;

        let scrollDelta = 0;
        if (lastClientX < leftEdge + EDGE_ZONE_PX) {
          const penetration = Math.min(1, (leftEdge + EDGE_ZONE_PX - lastClientX) / EDGE_ZONE_PX);
          scrollDelta = -MAX_SCROLL_SPEED_PX * penetration;
        } else if (lastClientX > rightEdge - EDGE_ZONE_PX) {
          const penetration = Math.min(1, (lastClientX - (rightEdge - EDGE_ZONE_PX)) / EDGE_ZONE_PX);
          scrollDelta = MAX_SCROLL_SPEED_PX * penetration;
        }

        if (scrollDelta !== 0) {
          const maxScrollLeft = el.scrollWidth - el.clientWidth;
          const prevScrollLeft = el.scrollLeft;
          const newScrollLeft = Math.min(maxScrollLeft, Math.max(0, prevScrollLeft + scrollDelta));
          const actualDelta = newScrollLeft - prevScrollLeft; // 0 once clamped at either end
          if (actualDelta !== 0) {
            el.scrollLeft = newScrollLeft;
            autoScrollAccumPx += actualDelta;
            applyDrag(lastClientX);
          }
        }
      }
      rafId = requestAnimationFrame(autoScrollTick);
    }
    rafId = requestAnimationFrame(autoScrollTick);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      cancelAnimationFrame(rafId);
    };
  }, [clipDrag, pixelsPerSecond]);

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
  // Timeline position (seconds) that the current/last transport run started from — the
  // seek/punch-in point. Read by handleStop (after the async recorder flush) to splice
  // the take into the track buffer at the right spot, so it must be a ref, not state.
  const punchInOffsetRef = useRef(0);
  const [recordPunchIn, setRecordPunchIn] = useState(0); // same value, for rendering the in-progress recording clip

  // Ctrl/Cmd+scroll-to-zoom (Ableton-style) — attached natively so preventDefault
  // actually stops the browser's own ctrl+wheel page zoom / trackpad pinch-zoom;
  // React's onWheel is passive by default and can't block that.
  const timelineAreaRef = useRef(null);
  // Updated synchronously by the wheel handler itself (never via an effect) so a fast
  // burst of wheel events — normal for a mouse wheel or trackpad — always computes each
  // step's anchor against the truly-current zoom, not one that's lagging a render behind.
  const zoomRef = useRef(zoom);
  // { mouseX, timeAtCursor } captured right before a zoom change, so the scroll-restore
  // effect below can keep the point under the cursor fixed — same feel as Ableton.
  const zoomAnchorRef = useRef(null);

  useEffect(() => {
    const el = timelineAreaRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // leave normal scrolling alone
      e.preventDefault();

      // mouseX must be relative to the scrollable content, not the whole panel — the
      // 180px "Track Controls" corner is sticky and never scrolls, so measuring from
      // the panel's own left edge overcounts by its width and the anchor point drifts
      // off just as fast as you zoom. Measuring from the corner's own right edge is
      // correct regardless of that width, sticky or not.
      const corner = el.querySelector('[class*="rulerCorner"]');
      const leftEdge = corner ? corner.getBoundingClientRect().right : el.getBoundingClientRect().left;
      const mouseX = e.clientX - leftEdge;

      const oldZoom = zoomRef.current;
      const oldPixelsPerSecond = (BASE_PIXELS_PER_BEAT * oldZoom * bpmRef.current) / 60;
      const timeAtCursor = (el.scrollLeft + mouseX) / oldPixelsPerSecond;

      const newZoom = Math.min(4, Math.max(0.15, oldZoom * Math.pow(1.0015, -e.deltaY)));
      zoomRef.current = newZoom;

      zoomAnchorRef.current = { mouseX, timeAtCursor };
      setZoom(newZoom);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // After a zoom-driven re-render lands (new pixelsPerSecond in effect), re-anchor the
  // scroll position so whatever was under the cursor stays under the cursor.
  useEffect(() => {
    const el = timelineAreaRef.current;
    const anchor = zoomAnchorRef.current;
    if (!el || !anchor) return;
    el.scrollLeft = anchor.timeAtCursor * pixelsPerSecond - anchor.mouseX;
    zoomAnchorRef.current = null;
  }, [zoom, pixelsPerSecond]);

  // Metronome refs
  const bpmRef = useRef(bpm);
  const beatsPerMeasureRef = useRef(beatsPerMeasure);
  const nextNoteTimeRef = useRef(0.0);
  const currentBeatRef = useRef(0);
  const metroTimerRef = useRef(null);
  const countInTimersRef = useRef([]);

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

  // Update track volumes and mutes — a track may have several live sources at once now
  // (one per audible clip segment), so this fans out across all of them.
  useEffect(() => {
    if (!audioCtxRef.current) return;
    const anySolo = tracks.some(t => t.isSoloed);
    tracks.forEach(track => {
      const sources = trackSourcesRef.current[track.id];
      if (!sources) return;
      let effectiveVol = track.volume;
      if (track.isMuted) effectiveVol = 0;
      if (anySolo && !track.isSoloed) effectiveVol = 0;
      sources.forEach(ts => {
        if (ts.gainNode) ts.gainNode.gain.setValueAtTime(effectiveVol, audioCtxRef.current.currentTime);
      });
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
      const t0 = transportStartTimeRef.current; // ctx time the transport is at `offset` (below)
      const offset = punchInOffsetRef.current; // timeline position the transport started from
      const secondsPerBeatNow = 60 / bpmRef.current;

      // Sync to the song's global bar/beat grid (anchored at timeline position 0)
      // instead of always treating the transport start as beat 1 — so the metronome's
      // accent lines up with whatever bar the playhead is actually in, not wherever you
      // happened to hit Play/Record from. Anchored purely to the fixed (t0, offset) pair
      // rather than "now" — reading ctx.currentTime here would race against however long
      // React took to run this effect after startPlayback set t0, silently nudging the
      // very first beat's index forward. If the metronome is flipped on well into an
      // already-running transport, metroScheduler's own catch-up loop (below) advances
      // through the gap on its next tick, same as it already does for BPM changes.
      const nextBeatIndex = Math.ceil(offset / secondsPerBeatNow - 1e-6);
      nextNoteTimeRef.current = t0 + (nextBeatIndex * secondsPerBeatNow - offset);
      const beatsInMeasure = beatsPerMeasureRef.current;
      currentBeatRef.current = ((nextBeatIndex % beatsInMeasure) + beatsInMeasure) % beatsInMeasure;
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
      countInTimersRef.current.forEach(id => clearTimeout(id));
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
    // Each track can have several live sources now (one per audible clip segment).
    Object.values(trackSourcesRef.current).forEach(sources => {
      sources.forEach(ts => {
        try {
          if (ts.source) ts.source.stop();
          if (ts.source) ts.source.disconnect();
          if (ts.gainNode) ts.gainNode.disconnect();
        } catch (e) {}
      });
    });
    trackSourcesRef.current = {};
    transportStartTimeRef.current = 0;
    cancelAnimationFrame(playheadRafRef.current);
    setIsPlaying(false);
    setIsRecording(false);
    // Deliberately leave `playhead` where it stopped, rather than snapping back to 0 —
    // that's what lets the needle be moved: click the ruler/grid to park it somewhere,
    // hit Play or Record, and it starts from there. Click position 0 to rewind.
  };

  /**
   * @param {boolean} recordMode
   * @param {number|null} seekOverride  Timeline seconds to start from; defaults to the
   *   current playhead position (i.e. wherever it was last left or seeked to).
   */
  const startPlayback = (recordMode = false, seekOverride = null) => {
    initAudio();
    const offset = Math.max(0, seekOverride !== null ? seekOverride : playhead);
    stopPlayback(); // stop any existing

    setIsPlaying(true);
    setIsRecording(recordMode);
    setPlayhead(offset);
    punchInOffsetRef.current = offset;
    if (recordMode) setRecordPunchIn(offset);

    // While recording, the transport downbeat (T0) sits a pre-roll ahead so the
    // recorder worklet is already capturing before it — this is what makes the
    // recorded take's position on the timeline sample-accurate. Plain playback
    // starts immediately. Seeking only shifts *where on the timeline* T0 lands —
    // the pre-roll/worklet alignment math in recorderEngine.js is untouched.
    const now = audioCtxRef.current.currentTime;
    const startAt = recordMode ? now + RECORD_PREROLL_SEC : now;
    startTimeRef.current = startAt;
    transportStartTimeRef.current = startAt;
    if (recordMode) setRecordingStartTime(startAt);

    const anySolo = tracks.some(t => t.isSoloed);

    tracks.forEach(track => {
      if (recordMode && track.isArmed) return; // about to be re-recorded — don't also play its old clips back

      // A track can hold several clips now; computeAudibleSegments resolves any
      // overlap (later clip wins) into a flat list of non-overlapping audible
      // segments, each of which gets its own scheduled source. Segments entirely
      // before the seek point are skipped; a segment straddling it starts partway
      // into its own buffer; a segment starting after it is scheduled later, once
      // the transport reaches that point.
      const segments = computeAudibleSegments(track.clips);
      const sources = [];
      segments.forEach(seg => {
        if (seg.segEnd <= offset) return;
        const playStart = Math.max(seg.segStart, offset);
        const segDuration = seg.segEnd - playStart;
        if (segDuration <= 0) return;
        const bufferOffset = (seg.clip.trimStart || 0) + (playStart - seg.clip.startTime);

        const source = audioCtxRef.current.createBufferSource();
        source.buffer = seg.clip.buffer;

        const gainNode = audioCtxRef.current.createGain();
        let effectiveVol = track.volume;
        if (track.isMuted) effectiveVol = 0;
        if (anySolo && !track.isSoloed) effectiveVol = 0;
        gainNode.gain.value = effectiveVol;

        source.connect(gainNode);
        gainNode.connect(masterGainRef.current);
        source.start(startAt + Math.max(0, playStart - offset), bufferOffset, segDuration);

        sources.push({ source, gainNode });
      });
      if (sources.length) trackSourcesRef.current[track.id] = sources;
    });

    const updatePlayhead = () => {
      // Clamp so the playhead sits at the seek offset during the pre-roll rather than
      // dipping below it.
      const current = offset + Math.max(0, audioCtxRef.current.currentTime - startTimeRef.current);
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

  // Double-clicking Stop rewinds the playhead to the very first beat — the single
  // click (which fires first, per the browser's normal click/dblclick sequence)
  // already stopped the transport via handleStop's onClick.
  const handleStopDoubleClick = () => {
    setPlayhead(0);
  };

  // Move the playhead by clicking the ruler or a track's grid lane. Blocked mid-take
  // (nothing sensible to do with "moving the needle" while it's actively recording),
  // but works both stopped (just parks it) and while playing (restarts from the new spot).
  const handleSeek = (e) => {
    if (isRecording || e.ctrlKey || e.metaKey) return; // Ctrl/Cmd+click is reserved for the pan drag below
    const rect = e.currentTarget.getBoundingClientRect();
    const time = Math.max(0, (e.clientX - rect.left) / pixelsPerSecond);
    if (isPlaying) {
      startPlayback(false, time);
    } else {
      setPlayhead(time);
    }
  };

  // Ctrl/Cmd+drag pans the timeline (both axes) without touching the scrollbar —
  // the click-to-drag counterpart to Ctrl/Cmd+scroll-to-zoom above.
  const [panDrag, setPanDrag] = useState(null); // { startX, startY, startScrollLeft, startScrollTop }

  const handleTimelineMouseDown = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const el = timelineAreaRef.current;
    if (!el) return;
    setPanDrag({ startX: e.clientX, startY: e.clientY, startScrollLeft: el.scrollLeft, startScrollTop: el.scrollTop });
  };

  useEffect(() => {
    if (!panDrag) return;
    const handleMouseMove = (e) => {
      const el = timelineAreaRef.current;
      if (!el) return;
      el.scrollLeft = panDrag.startScrollLeft - (e.clientX - panDrag.startX);
      el.scrollTop = panDrag.startScrollTop - (e.clientY - panDrag.startY);
    };
    const handleMouseUp = () => setPanDrag(null);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [panDrag]);

  function clearCountInTimers() {
    countInTimersRef.current.forEach(id => clearTimeout(id));
    countInTimersRef.current = [];
  }

  /**
   * Plays an audible click count-in — one full bar, so 4 beats by default, or however
   * many beats the current time signature has (3 for 3/4, 6 for 6/8, ...) — and resolves
   * once it's finished. Purely a courtesy delay in front of the real capture start — the
   * recorder graph is already connected (and thus already capturing) by the time this
   * runs, so however long the count-in takes, buildTrackBuffer's existing head-trim
   * (keyed off transportStartTime, set afterward by startPlayback) discards all of it.
   * The low-latency alignment math itself is untouched.
   */
  function playCountIn(ctx) {
    const beatDur = 60 / bpmRef.current;
    const countInBeats = beatsPerMeasureRef.current;
    const startAt = ctx.currentTime + 0.05;
    setIsCountingIn(true);
    setCountInBeat(-1);

    for (let i = 0; i < countInBeats; i++) {
      const t = startAt + i * beatDur;
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(masterGainRef.current);
      osc.frequency.setValueAtTime(i === 0 ? 1000 : 700, t);
      gainNode.gain.setValueAtTime(0.35, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      osc.start(t);
      osc.stop(t + 0.05);

      const delayMs = Math.max(0, (t - ctx.currentTime) * 1000);
      countInTimersRef.current.push(setTimeout(() => setCountInBeat(i), delayMs));
    }

    const totalDelayMs = Math.max(0, (startAt + countInBeats * beatDur - ctx.currentTime) * 1000);
    return new Promise((resolve) => {
      countInTimersRef.current.push(setTimeout(() => {
        setIsCountingIn(false);
        setCountInBeat(-1);
        resolve();
      }, totalDelayMs));
    });
  }

  const handleRecord = async () => {
    if (isCountingIn) {
      // Clicking Record/Stop again during the count-in cancels it outright.
      clearCountInTimers();
      setIsCountingIn(false);
      setCountInBeat(-1);
      teardownRecordingGraph();
      return;
    }
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

    // One-bar click count-in before the take actually starts — see playCountIn's own
    // comment for why this never touches the low-latency alignment.
    await playCountIn(ctx);
    if (!recorderRef.current) return; // cancelled mid-count-in

    // The recorder is already capturing (pre-roll). Start the transport at
    // T0 = now + RECORD_PREROLL_SEC; the worklet reports the exact frame it began so
    // buildTrackBuffer() can align the take to T0 with sample accuracy.
    startPlayback(true);
  };

  const handleStop = async () => {
    if (isCountingIn) {
      // The transport hasn't actually started yet (transportStartTimeRef is still from
      // the previous take, or 0) — building a buffer now would misalign it. Just cancel.
      clearCountInTimers();
      setIsCountingIn(false);
      setCountInBeat(-1);
      teardownRecordingGraph();
      return;
    }
    const recorder = recorderRef.current;
    const armedInputType = (tracks.find(t => t.isArmed)?.inputType) || 'both';
    const transportStartTime = transportStartTimeRef.current;
    const latencies = latenciesRef.current;
    const punchInOffset = punchInOffsetRef.current;

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
        // A fresh take becomes its own clip at the punch-in point. Clips on a track
        // never overlap — insertClipNonOverlapping trims (or splits) whatever was
        // already sitting there to make room, exactly like punch-in recording in any
        // other DAW; the user can still drag the trimmed edge back afterward.
        const newClip = { id: crypto.randomUUID(), startTime: punchInOffset, buffer: audioBuffer, trimStart: 0, trimEnd: 0 };
        setTracks(prev => prev.map(t => (
          t.isArmed ? { ...t, clips: insertClipNonOverlapping(t.clips, newClip) } : t
        )));
        useDawSession.getState().markDirty(songId);
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
    const sources = trackSourcesRef.current[trackId];
    if (sources) {
      sources.forEach(ts => {
        try {
          if (ts.source) ts.source.stop();
          if (ts.source) ts.source.disconnect();
          if (ts.gainNode) ts.gainNode.disconnect();
        } catch (e) {}
      });
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
        clips: [],
        volume: 0.8,
        isMuted: false,
        isSoloed: false,
        isArmed: false,
      }
    ]);
    setShowAddMenu(false);
  };

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
            <button
              className={styles.transBtn}
              onClick={handleStop}
              onDoubleClick={handleStopDoubleClick}
              title="Stop (double-click: rewind to start)"
            >
              ■ Stop
            </button>
            <button
              className={`${styles.transBtn} ${(isRecording || isCountingIn) ? styles.activeRecord : ''}`}
              onClick={handleRecord}
              title={isCountingIn ? 'Counting in — click to cancel' : 'Record (count-in first)'}
            >
              {isCountingIn ? `⏱ ${countInBeat + 1}` : '● Rec'}
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

              {/* Import a previously-exported (or any) audio file back in as a new track */}
              <input
                ref={importInputRef}
                type="file"
                accept="audio/*"
                multiple
                hidden
                onChange={handleImportFiles}
                id="import-audio-input"
              />
              <button
                className={styles.addTrackBtn}
                onClick={() => importInputRef.current?.click()}
                title="Import an audio file as a new track"
                id="import-audio-btn"
              >
                ⇩ Import
              </button>

              {/* Audio Export Dropdown */}
              <div className={styles.exportAudioWrapper} ref={exportAudioRef}>
                {dawDirty && (
                  <span className={styles.unexportedPill} title="This song has recorded or imported audio that hasn't been exported yet">
                    ● Unexported
                  </span>
                )}
                <button
                  className={`${styles.exportAudioBtn} ${hasRecordedAudio ? styles.hasAudio : ''}`}
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  title={dawDirty ? 'You have unexported audio — export to keep it' : 'Export recorded audio (.wav / .mp3)'}
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

              {/* Combined latency trim — voice + piano in one control, with recalibrate */}
              <div className={styles.latencyTrimContainer}>
                <span className={styles.latencyTrimLabel}>Trim</span>
                <div className={styles.trimStack}>
                  <div className={styles.trimMiniRow}>
                    <span className={styles.trimMiniIcon} title="Voice/mic recording latency trim">🎤</span>
                    <input
                      type="range"
                      min="-10" max="40" step="1"
                      value={latencyTrimMs}
                      onChange={e => setLatencyTrimMs(parseInt(e.target.value, 10))}
                      className={styles.latencyTrimSlider}
                      title={`Voice latency trim: ${latencyTrimMs}ms`}
                      id="scratchpad-voice-trim-slider"
                    />
                    <span className={styles.latencyTrimValue}>{latencyTrimMs}ms</span>
                  </div>
                  <div className={styles.trimMiniRow}>
                    <span className={styles.trimMiniIcon} title="Piano recording latency trim (lower = piano later)">🎹</span>
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
                <button
                  className={styles.helpBtn}
                  onClick={() => setShowLatencyHelper(true)}
                  title="Recalibrate voice & piano latency"
                  id="scratchpad-calibrate-latency-btn"
                >
                  🎯
                </button>
              </div>
            </div>
          </div>
      </div>

      {/* Unified Horizontal Timeline & Tracks Area */}
      {showDaw && (
        <div className={styles.timelineArea} ref={timelineAreaRef}>
          <div className={styles.timelineScrollContainer}>
            {/* Timeline Ruler Header */}
            <div className={styles.timeRuler}>
              <div className={styles.rulerCorner}>Track Controls</div>
              <div
                className={styles.rulerTrackArea}
                onClick={handleSeek}
                onMouseDown={handleTimelineMouseDown}
                style={panDrag ? { cursor: 'grabbing' } : undefined}
                title={`Click to move the playhead — Ctrl/Cmd+scroll to zoom (${Math.round(zoom * 100)}%) — Ctrl/Cmd+drag to pan`}
              >
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
                          className={styles.beatTickWrap}
                          style={{ left: `${(b / beatsPerMeasure) * 100}%` }}
                        >
                          {showBeatLabels && <span className={styles.beatLabel}>{m + 1}.{b + 1}</span>}
                          <div className={`${styles.beatTick} ${b === 0 ? styles.beatTickMeasure : ''}`} />
                        </div>
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
                          {track.clips.length > 0 && (
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
                    <div
                      className={styles.trackLane}
                      onClick={handleSeek}
                      onMouseDown={handleTimelineMouseDown}
                      style={panDrag ? { cursor: 'grabbing' } : undefined}
                      title="Click to move the playhead — Ctrl/Cmd+drag to pan"
                    >
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

                      {track.clips.map((clip, clipIdx) => {
                        const dur = clipDuration(clip);
                        const widthPx = Math.max(20, dur * pixelsPerSecond);
                        return (
                          <div
                            key={clip.id}
                            className={styles.clipBlock}
                            style={{ left: `${clip.startTime * pixelsPerSecond}px`, width: `${widthPx}px`, zIndex: 5 + clipIdx }}
                            onMouseDown={(e) => startClipMove(track.id, clip, e)}
                            onClick={(e) => e.stopPropagation()}
                            title="Drag to move — drag an edge to trim"
                          >
                            <div
                              className={`${styles.clipTrimHandle} ${styles.clipTrimHandleLeft}`}
                              onMouseDown={(e) => startClipTrim(track.id, clip, 'start', e)}
                            />
                            <WaveformCanvas
                              audioBuffer={clip.buffer}
                              trimStart={clip.trimStart}
                              trimEnd={clip.trimEnd}
                              width={widthPx}
                              height={Math.max(20, currentHeight - 22)}
                              isRecording={false}
                            />
                            <div
                              className={`${styles.clipTrimHandle} ${styles.clipTrimHandleRight}`}
                              onMouseDown={(e) => startClipTrim(track.id, clip, 'end', e)}
                            />
                          </div>
                        );
                      })}
                      {isRecording && track.isArmed && (
                        <div
                          className={`${styles.clipBlock} ${styles.recording}`}
                          style={{
                            left: `${recordPunchIn * pixelsPerSecond}px`,
                            width: `${Math.max(40, (playhead - recordPunchIn) * pixelsPerSecond)}px`,
                            zIndex: 999,
                          }}
                        >
                          <WaveformCanvas
                            audioBuffer={null}
                            width={Math.max(40, (playhead - recordPunchIn) * pixelsPerSecond)}
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
                  <li><strong>Resize:</strong> Drag the left border of DAW Studio to widen the panel for comfortable editing.</li>
                </ul>
              </div>
              <div className={styles.helpSection}>
                <h4>🔴 Recording & Controls</h4>
                <ul>
                  <li><strong>Arm Track (●):</strong> Click ● on a track header to arm it for recording.</li>
                  <li><strong>Move the Playhead:</strong> Click anywhere on the ruler or a track's lane to jump there — Play or Record starts from that point.</li>
                  <li><strong>Record (● Transport):</strong> Plays a one-bar count-in click (4 beats, or however many the time signature has), then begins recording into the armed track from the playhead's position. Click again (or Stop) during the count-in to cancel it.</li>
                  <li><strong>Metronome Sync:</strong> The click track lines up with the actual bar the playhead is in, not just wherever you hit Play or Record — so its downbeat accent stays correct even after seeking or changing a clip's length.</li>
                  <li><strong>Stop / Rewind:</strong> Click ■ Stop to stop; double-click it to also rewind the playhead back to the very start.</li>
                  <li><strong>Punch-In:</strong> Recording over part of an existing clip automatically trims that clip to make room — clips never overlap. Drag the trimmed edge afterward to reclaim it, up to where the two clips would touch again.</li>
                  <li><strong>Move & Trim Clips:</strong> Drag the middle of a clip to move it along the timeline; drag its left/right edge to trim it non-destructively.</li>
                </ul>
              </div>
              <div className={styles.helpSection}>
                <h4>⏱️ Timeline Grid & Waveforms</h4>
                <ul>
                  <li><strong>Horizontal Scroll:</strong> Scroll horizontally to view bars & measures across the timeline. Track controls stay locked on the left.</li>
                  <li><strong>Zoom:</strong> Hold Ctrl (Cmd on Mac) and scroll over the timeline to zoom in for precision or out to see your whole arrangement — it zooms around wherever your cursor is.</li>
                  <li><strong>Pan:</strong> Hold Ctrl/Cmd and click-drag anywhere on the timeline to slide it around without touching the scrollbar.</li>
                  <li><strong>Bar.Beat Labels:</strong> Zoom in far enough and each beat gets its own label (1.1, 1.2, 1.3, 1.4…) so you can line up precisely.</li>
                  <li><strong>Audio Waveforms:</strong> Recorded audio displays detailed peak waveforms. Active recording renders animated live signal waves.</li>
                  <li><strong>BPM & Metronome:</strong> Adjust tempo (40–240 BPM) and time signature (2/4, 3/4, 4/4, 6/8). Turning ON DAW metronome stops Piano metronome.</li>
                  <li><strong>Track Management:</strong> Use <strong>+ Add Track ▼</strong> to add new tracks and <strong>🗑️</strong> to delete tracks.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Latency Trim Helper — first-run (or manually re-opened) calibration popup
          that walks the user through calibrating both voice and piano. */}
      {showLatencyHelper && (
        <LatencyTrimHelper
          initialTrimMs={latencyTrimMs}
          initialPianoTrimMs={pianoTrimMs}
          onSave={({ trimMs, pianoTrimMs: pTrim }) => {
            setLatencyTrimMs(trimMs);
            setPianoTrimMs(pTrim);
            setShowLatencyHelper(false);
          }}
          onClose={() => setShowLatencyHelper(false)}
        />
      )}
    </div>
  );
}
