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
import { CHORD_DB, normalizeChordName } from '../utils/chords.js';
import { transposeChordToken, transposeChordsLine } from '../utils/transpose.js';

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
});
