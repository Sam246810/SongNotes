import { describe, it, expect } from 'vitest';
import { audioBufferToWav, audioBufferToMp3, mixTracksToMasterBuffer, sanitizeAudioFilename } from '../utils/audioExport';

describe('audioExport utility', () => {
  function createMockAudioBuffer(samples = 100, sampleRate = 44100) {
    const data = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      data[i] = Math.sin(i * 0.1) * 0.5;
    }
    return {
      numberOfChannels: 1,
      sampleRate,
      length: samples,
      duration: samples / sampleRate,
      getChannelData: () => data,
    };
  }

  it('sanitizes audio filenames correctly', () => {
    expect(sanitizeAudioFilename('My Vocal Track!')).toBe('My_Vocal_Track');
    expect(sanitizeAudioFilename('   ')).toBe('audio');
  });

  it('converts AudioBuffer to a valid WAV Blob', () => {
    const buffer = createMockAudioBuffer(200);
    const blob = audioBufferToWav(buffer);
    expect(blob).toBeTruthy();
    expect(blob.type).toBe('audio/wav');
    // Header size (44 bytes) + 200 samples * 2 bytes = 444 bytes
    expect(blob.size).toBe(444);
  });

  it('converts AudioBuffer to an MP3 Blob', async () => {
    const buffer = createMockAudioBuffer(200);
    const blob = await audioBufferToMp3(buffer);
    expect(blob).toBeTruthy();
    expect(blob.type).toBe('audio/mp3');
  });

  it('mixes active recorded tracks to a single master buffer', () => {
    const track1 = { id: '1', name: 'Vocals', audioBuffer: createMockAudioBuffer(100), volume: 0.8, isMuted: false, isSoloed: false };
    const track2 = { id: '2', name: 'Piano', audioBuffer: createMockAudioBuffer(150), volume: 0.7, isMuted: false, isSoloed: false };
    
    const master = mixTracksToMasterBuffer([track1, track2]);
    expect(master).toBeTruthy();
    expect(master.getChannelData(0).length).toBe(150);
  });

  it('skips muted tracks during mixing', () => {
    const track1 = { id: '1', name: 'Vocals', audioBuffer: createMockAudioBuffer(100), volume: 0.8, isMuted: true, isSoloed: false };
    const track2 = { id: '2', name: 'Piano', audioBuffer: createMockAudioBuffer(50), volume: 0.7, isMuted: false, isSoloed: false };
    
    const master = mixTracksToMasterBuffer([track1, track2]);
    expect(master).toBeTruthy();
    expect(master.getChannelData(0).length).toBe(50);
  });
});
