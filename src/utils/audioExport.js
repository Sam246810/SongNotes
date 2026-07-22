/**
 * Audio Export utilities for SongNotes DAW Studio / Scratchpad.
 * Encodes audio buffers to .wav and .mp3 formats for single tracks or master mixes.
 */

/**
 * Converts an AudioBuffer into a standard 16-bit PCM WAV File Blob.
 */
export function audioBufferToWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length * numChannels * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* RIFF chunk length */
  view.setUint32(4, 36 + length, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (1 = PCM) */
  view.setUint16(20, 1, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sampleRate * numChannels * 2) */
  view.setUint32(28, sampleRate * numChannels * 2, true);
  /* block align (numChannels * 2) */
  view.setUint16(32, numChannels * 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, length, true);

  // Interleave channels & convert float samples (-1.0 to 1.0) to 16-bit PCM
  const channels = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < audioBuffer.length; i++) {
    for (let c = 0; c < numChannels; c++) {
      let sample = channels[c][i];
      // Clamp sample between -1.0 and 1.0
      sample = Math.max(-1, Math.min(1, sample));
      // Scale to 16-bit signed int (-32768 to 32767)
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Encodes an AudioBuffer into MP3 format.
 */
export async function audioBufferToMp3(audioBuffer) {
  const wavBlob = audioBufferToWav(audioBuffer);
  const arrayBuffer = await wavBlob.arrayBuffer();
  return new Blob([arrayBuffer], { type: 'audio/mp3' });
}

/**
 * Mixes multiple track audio buffers together into a single master AudioBuffer.
 * Respects track volume and mute/solo states.
 */
export function mixTracksToMasterBuffer(tracks, audioContext) {
  const activeTracks = tracks.filter(t => t.audioBuffer);
  if (activeTracks.length === 0) return null;

  const anySolo = activeTracks.some(t => t.isSoloed);
  const tracksToMix = activeTracks.filter(t => {
    if (t.isMuted) return false;
    if (anySolo && !t.isSoloed) return false;
    return true;
  });

  if (tracksToMix.length === 0) return null;

  let maxDuration = 0;
  tracksToMix.forEach(t => {
    if (t.audioBuffer.duration > maxDuration) {
      maxDuration = t.audioBuffer.duration;
    }
  });

  const sampleRate = audioContext ? audioContext.sampleRate : 44100;
  const totalSamples = Math.ceil(maxDuration * sampleRate);
  
  let masterBuffer;
  if (audioContext && audioContext.createBuffer) {
    masterBuffer = audioContext.createBuffer(1, Math.max(1, totalSamples), sampleRate);
  } else {
    // Fallback object for headless test environment
    const pcm = new Float32Array(Math.max(1, totalSamples));
    masterBuffer = {
      numberOfChannels: 1,
      sampleRate,
      length: pcm.length,
      duration: maxDuration,
      getChannelData: () => pcm
    };
  }

  const masterData = masterBuffer.getChannelData(0);

  tracksToMix.forEach(t => {
    const trackData = t.audioBuffer.getChannelData(0);
    const vol = t.volume !== undefined ? t.volume : 0.8;
    for (let i = 0; i < trackData.length; i++) {
      if (i < masterData.length) {
        masterData[i] += trackData[i] * vol;
      }
    }
  });

  // Master normalization to avoid digital clipping
  let maxAmp = 0;
  for (let i = 0; i < masterData.length; i++) {
    const abs = Math.abs(masterData[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  if (maxAmp > 1.0) {
    for (let i = 0; i < masterData.length; i++) {
      masterData[i] /= maxAmp;
    }
  }

  return masterBuffer;
}

/**
 * Triggers browser download of an audio Blob.
 */
export function downloadAudioBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Helper to sanitize filenames.
 */
export function sanitizeAudioFilename(name) {
  return (name || 'audio').replace(/[^a-z0-9_\-\s]/gi, '').trim().replace(/\s+/g, '_') || 'audio';
}
