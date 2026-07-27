import { describe, it, expect } from 'vitest';
import { looksLikeChordLine, parseLyricsText } from '../utils/lyricsImport';

describe('looksLikeChordLine', () => {
  it('recognizes a typical spread-out chord line', () => {
    expect(looksLikeChordLine('G          C          D')).toBe(true);
  });

  it('recognizes a chord line with extended qualities', () => {
    expect(looksLikeChordLine('Am7   Dsus4   G/B   Cmaj7')).toBe(true);
  });

  it('rejects a normal lyric sentence', () => {
    expect(looksLikeChordLine('Amazing grace, how sweet the sound')).toBe(false);
  });

  it('rejects a lyric line ending in punctuation even if it starts with a chord-like word', () => {
    expect(looksLikeChordLine('Did I do that?')).toBe(false);
  });

  it('rejects a lowercase one-word line that happens to collide with a chord letter', () => {
    // "a" would normalize to chord "A" if case were ignored — must not misfire.
    expect(looksLikeChordLine('a')).toBe(false);
  });

  it('still recognizes an actual single-chord line when properly capitalized', () => {
    expect(looksLikeChordLine('Am')).toBe(true);
  });

  it('treats blank/whitespace-only text as not a chord line', () => {
    expect(looksLikeChordLine('')).toBe(false);
    expect(looksLikeChordLine('    ')).toBe(false);
  });

  it('tolerates a minority of non-chord annotation tokens', () => {
    expect(looksLikeChordLine('G    C    (slow down)    D')).toBe(true);
  });

  it('rejects a line that is mostly prose with one incidental chord-like word', () => {
    expect(looksLikeChordLine('C is for cookie, and that is good enough for me')).toBe(false);
  });
});

describe('parseLyricsText', () => {
  it('pairs a chord line with the lyric line beneath it', () => {
    const { lines } = parseLyricsText('G          C          D\nAmazing grace, how sweet the sound');
    expect(lines).toEqual([
      { chords: 'G          C          D', lyrics: 'Amazing grace, how sweet the sound' },
    ]);
  });

  it('keeps chord-column alignment intact (chords stay above the same characters)', () => {
    const chordLine = '   G        C';
    const lyricLine = 'Well hello there friend';
    const { lines } = parseLyricsText(`${chordLine}\n${lyricLine}`);
    expect(lines[0].chords).toBe(chordLine);
    expect(lines[0].lyrics).toBe(lyricLine);
    // "G" in chords is at index 3, matching under "hello" starting at index 5... the
    // important invariant is just that we never rewrote either string.
    expect(lines[0].chords.indexOf('G')).toBe(chordLine.indexOf('G'));
  });

  it('treats a plain lyric-only song as all-lyric lines with no chords', () => {
    const text = 'Row, row, row your boat\nGently down the stream';
    const { lines } = parseLyricsText(text);
    expect(lines).toEqual([
      { chords: '', lyrics: 'Row, row, row your boat' },
      { chords: '', lyrics: 'Gently down the stream' },
    ]);
  });

  it('detects a title header and strips it, matching exportToText\'s own format', () => {
    const text = 'Yesterday\n=========\n\nG          Am\nYesterday, all my troubles seemed so far away';
    const { title, lines } = parseLyricsText(text);
    expect(title).toBe('Yesterday');
    expect(lines).toEqual([
      { chords: 'G          Am', lyrics: 'Yesterday, all my troubles seemed so far away' },
    ]);
  });

  it('does not misdetect a normal two-line song as having a title header', () => {
    const { title, lines } = parseLyricsText('First line\nSecond line');
    expect(title).toBeNull();
    expect(lines).toEqual([
      { chords: '', lyrics: 'First line' },
      { chords: '', lyrics: 'Second line' },
    ]);
  });

  it('keeps a standalone instrumental chord line (not followed by lyrics) as chords-only', () => {
    const { lines } = parseLyricsText('Verse\n\nG   C   D   G\n\nBridge');
    expect(lines).toEqual([
      { chords: '', lyrics: 'Verse' },
      { chords: '', lyrics: '' },
      { chords: 'G   C   D   G', lyrics: '' },
      { chords: '', lyrics: '' },
      { chords: '', lyrics: 'Bridge' },
    ]);
  });

  it('does not pair two consecutive chord lines with each other', () => {
    const { lines } = parseLyricsText('G   C\nAm   F\nHere come the lyrics finally');
    expect(lines).toEqual([
      { chords: 'G   C', lyrics: '' },
      { chords: 'Am   F', lyrics: 'Here come the lyrics finally' },
    ]);
  });

  it('preserves internal blank lines between verses', () => {
    const { lines } = parseLyricsText('First verse line\n\nSecond verse line');
    expect(lines).toEqual([
      { chords: '', lyrics: 'First verse line' },
      { chords: '', lyrics: '' },
      { chords: '', lyrics: 'Second verse line' },
    ]);
  });

  it('trims leading and trailing blank lines', () => {
    const { lines } = parseLyricsText('\n\n  \nOnly line\n\n\n');
    expect(lines).toEqual([{ chords: '', lyrics: 'Only line' }]);
  });

  it('handles Windows-style line endings', () => {
    const { lines } = parseLyricsText('G   C\r\nHello there\r\n');
    expect(lines).toEqual([{ chords: 'G   C', lyrics: 'Hello there' }]);
  });

  it('returns an empty lines array for empty input', () => {
    const { title, lines } = parseLyricsText('');
    expect(title).toBeNull();
    expect(lines).toEqual([]);
  });

  it('handles a mixed song with both chorded and plain lyric lines', () => {
    const text = [
      'G          C',
      'This line has chords',
      'This line does not',
      'D          Em',
      'Neither does this one wait yes it does',
    ].join('\n');
    const { lines } = parseLyricsText(text);
    expect(lines).toEqual([
      { chords: 'G          C', lyrics: 'This line has chords' },
      { chords: '', lyrics: 'This line does not' },
      { chords: 'D          Em', lyrics: 'Neither does this one wait yes it does' },
    ]);
  });

  describe('bracketed chord cues', () => {
    it('pairs a single bracketed chord with the lyric line beneath it', () => {
      const { lines } = parseLyricsText('[G#maj]\nFor all the heart I have');
      expect(lines).toEqual([{ chords: 'G#maj', lyrics: 'For all the heart I have' }]);
    });

    it('preserves leading whitespace as the intended column position', () => {
      const { lines } = parseLyricsText('          [G#maj]\nFor all the heart I have');
      expect(lines).toEqual([{ chords: '          G#maj', lyrics: 'For all the heart I have' }]);
    });

    it('handles multiple bracketed chords on one cue line', () => {
      const { lines } = parseLyricsText('[Fmin] [G#maj]\nWhat is the color of your butterflies');
      expect(lines).toEqual([{ chords: 'Fmin G#maj', lyrics: 'What is the color of your butterflies' }]);
    });

    it('recognizes minor and compound-notation brackets', () => {
      const { lines } = parseLyricsText('[A#min]\nWhat are just niceties');
      expect(lines[0].chords).toBe('A#min');
      const compound = parseLyricsText('[Cmaj-//-C#maj]\nId never go back');
      expect(compound.lines[0].chords).toBe('Cmaj-//-C#maj');
    });

    it('does not mistake a bracketed section marker for a chord', () => {
      const { lines } = parseLyricsText('[Verse]\n[G#maj]\nFor all the heart I have');
      expect(lines).toEqual([
        { chords: '', lyrics: '[Verse]' },
        { chords: 'G#maj', lyrics: 'For all the heart I have' },
      ]);
    });

    it('keeps a standalone instrumental chord cue from swallowing a following section marker as lyrics', () => {
      const text = '[Instrumental]\n[F#maj] [A#min] [F#maj]\n\n[Bridge] (very very tentative)\nWhatever happens';
      const { lines } = parseLyricsText(text);
      expect(lines).toEqual([
        { chords: '', lyrics: '[Instrumental]' },
        { chords: 'F#maj A#min F#maj', lyrics: '' },
        { chords: '', lyrics: '' },
        { chords: '', lyrics: '[Bridge] (very very tentative)' },
        { chords: '', lyrics: 'Whatever happens' },
      ]);
    });

    it('does not mistake a section marker with descriptive text for a chord cue', () => {
      const { lines } = parseLyricsText('[Last Chorus Ending (rest is the same)]\nMaybe instead of a last chorus');
      expect(lines[0]).toEqual({ chords: '', lyrics: '[Last Chorus Ending (rest is the same)]' });
    });

    it('handles a realistic excerpt mixing chords, section markers, and plain lyrics', () => {
      const text = [
        '[Verse]',
        '          [G#maj]',
        'For all the heart I have',
        '                       [F#maj]',
        'I never put it on the line',
        '',
        '[Chorus]',
        '          [G#maj]',
        'When you hear me call out your name',
      ].join('\n');
      const { lines } = parseLyricsText(text);
      expect(lines).toEqual([
        { chords: '', lyrics: '[Verse]' },
        { chords: '          G#maj', lyrics: 'For all the heart I have' },
        { chords: '                       F#maj', lyrics: 'I never put it on the line' },
        { chords: '', lyrics: '' },
        { chords: '', lyrics: '[Chorus]' },
        { chords: '          G#maj', lyrics: 'When you hear me call out your name' },
      ]);
    });
  });

  describe('Key/BPM/Capo/Tuning header detection', () => {
    it('extracts a Key/BPM header block and excludes it from the lines', () => {
      const text = 'Key: C# Maj\nBPM: 118\n\n[Verse]\n[G#maj]\nFor all the heart I have';
      const { meta, lines } = parseLyricsText(text);
      expect(meta).toEqual({ key: 'C# Maj', bpm: '118' });
      expect(lines[0]).toEqual({ chords: '', lyrics: '[Verse]' });
    });

    it('extracts all four header fields when present', () => {
      const text = 'Key: G\nBPM: 90\nCapo: 2\nTuning: Drop D\n\nSome lyric line';
      const { meta } = parseLyricsText(text);
      expect(meta).toEqual({ key: 'G', bpm: '90', capo: '2', tuning: 'Drop D' });
    });

    it('returns an empty meta object when no header is present', () => {
      const { meta, lines } = parseLyricsText('Just a regular lyric line');
      expect(meta).toEqual({});
      expect(lines).toEqual([{ chords: '', lyrics: 'Just a regular lyric line' }]);
    });

    it('does not misdetect an ordinary lyric line as a header', () => {
      const { meta, lines } = parseLyricsText('Key change is coming soon\nfor everyone involved');
      expect(meta).toEqual({});
      expect(lines[0].lyrics).toBe('Key change is coming soon');
    });

    it('still detects a header line with a uniform left-margin indent, as PDF extraction commonly produces', () => {
      const text = '              Key: C# Maj\n              BPM: 118\n              [Verse]\n              [G#maj]\n              For all the heart I have';
      const { meta, lines } = parseLyricsText(text);
      expect(meta).toEqual({ key: 'C# Maj', bpm: '118' });
      expect(lines[0]).toEqual({ chords: '', lyrics: '              [Verse]' });
    });
  });
});
