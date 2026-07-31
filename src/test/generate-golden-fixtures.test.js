// Generates ground-truth (input -> output) fixtures for normalizeChordName
// and the transpose functions by running the REAL implementation (imported
// below, not a reimplementation) over a broad set of inputs and recording
// whatever it actually returns. This is the "don't hand-translate tests"
// strategy from docs/PLAN.md in the SongNotes-Android repo: the Kotlin
// port runs a parameterized test over these exact fixtures and asserts
// byte-identical output, so any future divergence between the two
// implementations fails a build instead of silently drifting.
//
// A Vitest test file rather than a plain `node script.mjs` specifically so
// it resolves this project's extensionless relative imports (chords.js
// importing './chords' etc.) the same way the app itself does — plain
// Node's ESM loader doesn't support that without Vite's resolution layer.
//
// Run with: npx vitest run src/test/generate-golden-fixtures.test.js
// Committed fixtures live in spec/*.json — committed to BOTH this repo
// and SongNotes-Android, per the plan. Re-run this whenever
// normalizeChordName/transposeChordToken/transposeChordsLine change, and
// commit the regenerated fixtures to both repos again.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHORD_DB, normalizeChordName, tokenizeChordLine,
  formatFretsForInput, parseFretsInput, alignChordsWithLyrics,
} from '../utils/chords.js';
import { transposeChordToken, transposeChordsLine } from '../utils/transpose.js';
import { looksLikeChordLine, parseLyricsText } from '../utils/lyricsImport.js';
import { createAccountKeys, unlockWithPassphrase, unlockWithRecoveryCode } from '../crypto/accountKeys.js';
import { bufToBase64 } from '../crypto/base64.js';

function splitRootSuffix(name) {
  const m = name.match(/^([A-G])([#b]?)/);
  if (!m) return { rootAcc: name, suffix: '' };
  return { rootAcc: m[0], suffix: name.slice(m[0].length) };
}

// Every CHORD_DB entry, in every notation variant a real user might
// plausibly type for that quality — case, whitespace, jazz shorthand
// (-, +, °), verbose spellings (min/minor/maj), and a handful of slash-bass
// forms. All ground truth: whatever normalizeChordName(variant) actually
// returns gets recorded, not predicted.
function variantsFor(base) {
  const { rootAcc, suffix } = splitRootSuffix(base);
  const variants = new Set();

  variants.add(base);
  variants.add(base.toLowerCase());
  variants.add(base.toUpperCase());
  variants.add(rootAcc.toLowerCase() + suffix);
  variants.add(base + '  ');
  variants.add('  ' + base);
  variants.add(base + '\t');
  variants.add(' ' + base + ' ');

  if (suffix === 'm') {
    variants.add(rootAcc + '-');
    variants.add(rootAcc + 'min');
    variants.add(rootAcc + 'minor');
    variants.add(rootAcc + 'Min');
    variants.add(rootAcc + 'MINOR');
  } else if (suffix.startsWith('m') && suffix.length > 1) {
    variants.add(rootAcc + '-' + suffix.slice(1)); // e.g. m7 -> "-7"
  } else if (suffix === '') {
    variants.add(rootAcc + 'maj');
    variants.add(rootAcc + 'M');
    variants.add(rootAcc + 'Maj');
  } else if (suffix === 'maj7') {
    variants.add(rootAcc + 'maj#7');
    variants.add(rootAcc + 'maj 7');
    variants.add(rootAcc + 'MAJ7');
    variants.add(rootAcc + 'M7'); // known quirk: bare "M" strips, "M7" doesn't
  } else if (suffix === 'maj9') {
    variants.add(rootAcc + 'MAJ9');
    variants.add(rootAcc + 'maj 9');
  } else if (suffix === 'sus4') {
    variants.add(rootAcc + 'sus');
    variants.add(rootAcc + 'Sus4');
    variants.add(rootAcc + 'SUS');
  } else if (suffix === 'sus2') {
    variants.add(rootAcc + 'Sus2');
    variants.add(rootAcc + 'SUS2');
  } else if (suffix === 'add9') {
    variants.add(rootAcc + 'Add9');
    variants.add(rootAcc + 'ADD9');
  } else if (suffix === 'add11') {
    variants.add(rootAcc + 'Add11');
  } else if (suffix === 'aug') {
    variants.add(rootAcc + '+');
  } else if (suffix === 'dim' || suffix === 'dim7') {
    variants.add(rootAcc + '°');
  }

  for (const bass of ['A', 'C', 'D', 'G']) {
    variants.add(base + '/' + bass);
  }

  return Array.from(variants);
}

function buildNormalizeFixtures() {
  const inputs = new Set();
  for (const base of Object.keys(CHORD_DB)) {
    for (const v of variantsFor(base)) inputs.add(v);
  }

  // Systematic jazz-shorthand + verbose-spelling coverage across every root
  // spelling, not just the ones that happen to have a literal CHORD_DB entry.
  const ALL_ROOT_SPELLINGS = [
    'A', 'A#', 'Bb', 'B', 'C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab',
  ];
  for (const r of ALL_ROOT_SPELLINGS) {
    inputs.add(r + '-');
    inputs.add(r + '+');
    inputs.add(r + '°');
    inputs.add(r + '-7');
    inputs.add(r + 'min');
    inputs.add(r + 'minor');
    inputs.add(r + 'maj7');
    inputs.add(r + 'sus4');
    inputs.add(r.toLowerCase());
  }

  // The ENHARMONIC table's exact keys — the whole point of that table is to
  // remap these, so every one of them needs a fixture.
  for (const key of ['Gb', 'Gbm', 'Gb7', 'Cb', 'Cbm', 'Fb', 'Fbm', 'A#m', 'Ebm']) {
    inputs.add(key);
  }

  // Full combinatorial matrix: every root x accidental x quality suffix,
  // independent of what's literally in CHORD_DB (which doesn't cover every
  // combination) -- this is what gets normalizeChordName's own fixture set
  // up near the plan's "~2000 chord strings" figure with real, structurally
  // meaningful coverage rather than padding.
  const ROOTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const ACCIDENTALS = ['', '#', 'b'];
  const QUALITIES = [
    '', 'm', '7', 'm7', 'maj7', 'maj9', 'sus2', 'sus4', 'add9', 'add11',
    'aug', 'dim', 'dim7', '6', '5', 'min', 'minor', 'M', '-', '+', '°',
    '-7', 'Maj', 'MIN', 'sus',
  ];
  for (const r of ROOTS) {
    for (const a of ACCIDENTALS) {
      for (const q of QUALITIES) {
        inputs.add(r + a + q);
      }
    }
  }

  // Edge cases and deliberately-unrecognized inputs (still deterministic —
  // normalizeChordName never throws, so these all have a real expected output).
  for (const edge of [
    '', '   ', '\t', 'Xyz', 'Am9', 'Cadd11', 'H', 'H7', '1234', 'c', 'g#madd9',
    'A / B', 'C/', '/C', 'C11', 'C13', 'Cb5', 'C#5', 'z', 'ZZ99',
  ]) {
    inputs.add(edge);
  }

  return Array.from(inputs)
    .sort()
    .map((input) => ({ input, output: normalizeChordName(input) }));
}

function buildTransposeTokenFixtures() {
  const fixtures = [];
  for (const base of Object.keys(CHORD_DB)) {
    for (let semitones = -12; semitones <= 12; semitones++) {
      fixtures.push({ input: base, semitones, output: transposeChordToken(base, semitones) });
    }
  }
  for (const token of ['D/F#', 'G/B', 'C/E', 'Am/C', 'F#m7/A']) {
    for (const semitones of [-12, -7, -1, 0, 1, 5, 7, 12]) {
      fixtures.push({ input: token, semitones, output: transposeChordToken(token, semitones) });
    }
  }
  return fixtures;
}

function buildTransposeLineFixtures() {
  const chordLines = [
    'C       G       Am      F',
    'D  A  Bm  G',
    'Em7  Cmaj7  D  G',
    '   ',
    'C/E   F   G/B   C',
    'IntroSection C G Am F',
    'F#m  A  E  B',
  ];
  const fixtures = [];
  for (const line of chordLines) {
    for (const semitones of [-12, -5, -1, 0, 1, 5, 12]) {
      fixtures.push({ input: line, semitones, output: transposeChordsLine(line, semitones) });
    }
  }
  return fixtures;
}

// looksLikeChordLine: the hand-crafted cases from lyricsImport.test.js
// (the highest-value inputs — each one exercises a specific decision the
// function makes) plus a broader spread of chord-line/prose variety.
function buildLooksLikeChordLineFixtures() {
  const inputs = [
    'G          C          D',
    'Am7   Dsus4   G/B   Cmaj7',
    'Amazing grace, how sweet the sound',
    'Did I do that?',
    'a',
    'Am',
    '',
    '    ',
    'G    C    (slow down)    D',
    'C is for cookie, and that is good enough for me',
    // Broader spread: single chords across all 12 roots, sparse and dense
    // chord rows, mixed-case prose, punctuation edge cases.
    'A', 'Bm', 'C#', 'Db7', 'Esus4', 'F#m7', 'G/B',
    'A   B   C   D   E   F   G',
    'Verse 1',
    'Chorus:',
    'la la la',
    'Oh!',
    'G,C,D',
    '   G   ',
    'g c d', // lowercase -- must not misfire per the "a" test's own reasoning
  ];
  return inputs.map((input) => ({ input, output: looksLikeChordLine(input) }));
}

// parseLyricsText: the 25 hand-crafted scenarios from lyricsImport.test.js
// (title header, meta header block, bracketed chord cues, section markers,
// mixed conventions, Windows line endings, indentation, empty input) --
// these are the highest-value fixtures since each targets one specific
// parsing decision -- plus a couple of longer, more realistic full-song
// texts mixing several conventions at once.
function buildParseLyricsTextFixtures() {
  const inputs = [
    'G          C          D\nAmazing grace, how sweet the sound',
    '   G        C\nWell hello there friend',
    'Row, row, row your boat\nGently down the stream',
    'Yesterday\n=========\n\nG          Am\nYesterday, all my troubles seemed so far away',
    'First line\nSecond line',
    'Verse\n\nG   C   D   G\n\nBridge',
    'G   C\nAm   F\nHere come the lyrics finally',
    'First verse line\n\nSecond verse line',
    '\n\n  \nOnly line\n\n\n',
    'G   C\r\nHello there\r\n',
    '',
    ['G          C', 'This line has chords', 'This line does not', 'D          Em',
      'Neither does this one wait yes it does'].join('\n'),
    '[G#maj]\nFor all the heart I have',
    '          [G#maj]\nFor all the heart I have',
    '[Fmin] [G#maj]\nWhat is the color of your butterflies',
    '[A#min]\nWhat are just niceties',
    '[Cmaj-//-C#maj]\nId never go back',
    '[Verse]\n[G#maj]\nFor all the heart I have',
    '[Instrumental]\n[F#maj] [A#min] [F#maj]\n\n[Bridge] (very very tentative)\nWhatever happens',
    '[Last Chorus Ending (rest is the same)]\nMaybe instead of a last chorus',
    ['[Verse]', '          [G#maj]', 'For all the heart I have', '                       [F#maj]',
      'I never put it on the line', '', '[Chorus]', '          [G#maj]',
      'When you hear me call out your name'].join('\n'),
    'Key: C# Maj\nBPM: 118\n\n[Verse]\n[G#maj]\nFor all the heart I have',
    'Key: G\nBPM: 90\nCapo: 2\nTuning: Drop D\n\nSome lyric line',
    'Just a regular lyric line',
    'Key change is coming soon\nfor everyone involved',
    '              Key: C# Maj\n              BPM: 118\n              [Verse]\n              [G#maj]\n              For all the heart I have',
    // Extra: a longer realistic song mixing both chord notations across
    // multiple verses/sections, not covered verbatim by any single unit test.
    [
      'Home', '====', '',
      'Key: D', 'Capo: 2', '',
      '[Verse]',
      'D          G          A',
      'Woke up this morning to the sound of rain',
      '[Bmin]',
      'Nothing has ever felt so plain',
      '',
      '[Chorus]',
      'G     D     A     Bm',
      'This is the place I call my own',
      '',
      '[Bridge] (quiet, half-time)',
      'Just a whisper in the dark',
    ].join('\n'),
  ];
  return inputs.map((input) => ({ input, output: parseLyricsText(input) }));
}

// tokenizeChordLine: a spread of chord-track lines covering whitespace
// tokenization, mixed known/unknown chords, and empty input -- the
// dependency looksLikeChordLine relies on for its own token classification.
function buildTokenizeChordLineFixtures() {
  const inputs = [
    '', '   ', 'G', 'G   C   D', '  G  C  ', 'Am7 Dsus4 G/B Cmaj7',
    'G Xyz D', 'g c d', 'C#m7b5', 'C is for cookie',
  ];
  return inputs.map((input) => ({ input, output: tokenizeChordLine(input) }));
}

// formatFretsForInput: every real CHORD_DB voicing's frets array (broad,
// realistic coverage of muted/open/fretted-string combinations) plus a
// couple of synthetic edge cases.
function buildFormatFretsForInputFixtures() {
  const inputs = Object.values(CHORD_DB).map((v) => v.frets);
  inputs.push([-1, -1, -1, -1, -1, -1], [0, 0, 0, 0, 0, 0], [24, 24, 24, 24, 24, 24]);
  return inputs.map((input) => ({ input, output: formatFretsForInput(input) }));
}

// parseFretsInput: the hand-crafted cases from chords.test.js (valid
// 6-value strings, x/X muted-string casing, extra whitespace, a
// baseFret > 1 case, the formatFretsForInput round-trip, and every
// rejection path -- wrong value count, non-numeric, empty/null) plus a
// couple of extra edge cases (fret > 24, all-muted).
function buildParseFretsInputFixtures() {
  const inputs = [
    'x 3 2 0 1 0', 'X 0 2 2 2 0', '  x   3  2 0 1  0 ', 'x 6 8 8 7 6',
    formatFretsForInput(CHORD_DB.Am7.frets),
    'x 3 2 0 1', 'x 3 2 0 1 0 3', 'x 3 2 0 y 0', '', null,
    'x x x x x x', '0 0 0 0 0 0', 'x 25 2 0 1 0', '   ',
  ];
  return inputs.map((input) => ({ input, output: parseFretsInput(input) }));
}

// alignChordsWithLyrics: the hand-crafted cases from chords.test.js
// (both-empty, padding-shorter, trimming-longer-if-whitespace-only,
// NOT-trimming-longer-if-real-content) plus a couple of extra
// null/undefined-parameter edge cases.
function buildAlignChordsWithLyricsFixtures() {
  const pairs = [
    ['', ''], [null, null],
    ['C', 'Hello'], ['C G', 'Hello world'],
    ['C    ', 'Hi'], ['C G   ', 'Hello'],
    ['C    G', 'Hi'], ['C  Am  ', 'Hi'],
    [null, 'Hello'], ['C', null], ['', 'Hello'], ['C', ''],
  ];
  return pairs.map(([chords, lyrics]) => ({ chords, lyrics, output: alignChordsWithLyrics(chords, lyrics) }));
}

// Envelope v2 cross-repo test vector (SongNotes-Android Phase 6): builds a REAL
// account-key envelope via createAccountKeys (real random salts/IVs, same as
// production) and exports the raw DEK bytes alongside it, so the Kotlin side can
// unlock the exact same envelope with the same passphrase/recovery code and assert
// it recovers byte-identical DEK material -- proving the envelope format, Argon2id
// KDF, and AES-GCM unwrap are all cross-implementation-compatible, not just
// internally self-consistent. The reverse direction (an Android-built envelope
// decrypting here) is exercised by the `envelope-v2-from-android.json` test below,
// written by :core:data's own EnvelopeV2GoldenFixtureTest.kt when that suite runs.
async function buildEnvelopeV2Fixture() {
  const passphrase = 'correct horse battery staple';
  const recoveryCode = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2';
  const { dek, envelope } = await createAccountKeys(passphrase, recoveryCode);
  const rawDek = await crypto.subtle.exportKey('raw', dek);

  // Sanity-check the fixture unlocks correctly before ever committing it — a fixture
  // that doesn't even round-trip in its own language would be worse than no fixture.
  const viaPassphrase = await unlockWithPassphrase(envelope, passphrase);
  const viaRecovery = await unlockWithRecoveryCode(envelope, recoveryCode);
  const rawViaPassphrase = await crypto.subtle.exportKey('raw', viaPassphrase);
  const rawViaRecovery = await crypto.subtle.exportKey('raw', viaRecovery);
  if (bufToBase64(rawViaPassphrase) !== bufToBase64(rawDek)) throw new Error('passphrase unlock mismatch');
  if (bufToBase64(rawViaRecovery) !== bufToBase64(rawDek)) throw new Error('recovery unlock mismatch');

  return {
    passphrase,
    recoveryCode,
    expectedDekBase64: bufToBase64(rawDek),
    envelope,
  };
}

const specDir = path.resolve(import.meta.dirname, '../../spec');

describe('golden fixture generation (SongNotes-Android Phase 5 cross-check)', () => {
  it('writes spec/normalize-chord-name.json from the real normalizeChordName', () => {
    const fixtures = buildNormalizeFixtures();
    expect(fixtures.length).toBeGreaterThan(1000);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'normalize-chord-name.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/transpose-chord-token.json from the real transposeChordToken', () => {
    const fixtures = buildTransposeTokenFixtures();
    expect(fixtures.length).toBeGreaterThan(1000);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'transpose-chord-token.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/transpose-chords-line.json from the real transposeChordsLine', () => {
    const fixtures = buildTransposeLineFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'transpose-chords-line.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/tokenize-chord-line.json from the real tokenizeChordLine', () => {
    const fixtures = buildTokenizeChordLineFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'tokenize-chord-line.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/looks-like-chord-line.json from the real looksLikeChordLine', () => {
    const fixtures = buildLooksLikeChordLineFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'looks-like-chord-line.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/parse-lyrics-text.json from the real parseLyricsText', () => {
    const fixtures = buildParseLyricsTextFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'parse-lyrics-text.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/format-frets-for-input.json from the real formatFretsForInput', () => {
    const fixtures = buildFormatFretsForInputFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'format-frets-for-input.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/parse-frets-input.json from the real parseFretsInput', () => {
    const fixtures = buildParseFretsInputFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'parse-frets-input.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/align-chords-with-lyrics.json from the real alignChordsWithLyrics', () => {
    const fixtures = buildAlignChordsWithLyricsFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'align-chords-with-lyrics.json'), JSON.stringify(fixtures, null, 2) + '\n');
  });

  it('writes spec/envelope-v2.json from the real createAccountKeys (Phase 6 cross-repo test vector)', async () => {
    const fixture = await buildEnvelopeV2Fixture();
    expect(fixture.envelope.v).toBe(2);
    expect(fixture.envelope.wraps).toHaveLength(2);
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'envelope-v2.json'), JSON.stringify(fixture, null, 2) + '\n');
  });

  it('reads spec/envelope-v2-from-android.json (if present) and unlocks it with both wraps', async () => {
    const fixturePath = path.join(specDir, 'envelope-v2-from-android.json');
    if (!fs.existsSync(fixturePath)) {
      // Not generated yet on this machine -- :core:data's EnvelopeV2GoldenFixtureTest.kt
      // writes it when run. Not a failure: this direction is verified whenever both
      // suites have run at least once and the file is committed, same as any other
      // golden fixture in this repo.
      return;
    }
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    const viaPassphrase = await unlockWithPassphrase(fixture.envelope, fixture.passphrase);
    const viaRecovery = await unlockWithRecoveryCode(fixture.envelope, fixture.recoveryCode);
    const rawViaPassphrase = bufToBase64(await crypto.subtle.exportKey('raw', viaPassphrase));
    const rawViaRecovery = bufToBase64(await crypto.subtle.exportKey('raw', viaRecovery));
    expect(rawViaPassphrase).toBe(fixture.expectedDekBase64);
    expect(rawViaRecovery).toBe(fixture.expectedDekBase64);
  });
});
