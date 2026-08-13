import { describe, it, expect } from 'vitest';
import { normalizeRecoveryCode, describeRecoveryCodeInput, RECOVERY_CODE_ALPHABET } from '../crypto/recoveryCode';
import { generateRecoveryCode } from '../crypto/accountKeys';

describe('normalizeRecoveryCode', () => {
  it('is a no-op on a canonically-generated code', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateRecoveryCode();
      expect(normalizeRecoveryCode(code)).toBe(code);
    }
  });

  it('uppercases lowercase input', () => {
    expect(normalizeRecoveryCode('abcde-fghjk-lmnpq-rstuv')).toBe('ABCDE-FGHJK-LMNPQ-RSTUV');
  });

  it('strips hyphens and re-inserts them canonically, with no trailing separator', () => {
    expect(normalizeRecoveryCode('abcdefghjklmnpqrstuv')).toBe('ABCDE-FGHJK-LMNPQ-RSTUV');
    // 25 chars (divisible by 5) -- must NOT get a trailing hyphen
    expect(normalizeRecoveryCode('ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2')).toBe('ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2');
  });

  it('strips whitespace of all kinds', () => {
    expect(normalizeRecoveryCode(' ABCDE FGHJK\tLMNPQ\nRSTUV ')).toBe('ABCDE-FGHJK-LMNPQ-RSTUV');
  });

  it('strips characters outside the alphabet (0, 1, I, O) but keeps L, which is valid', () => {
    expect(normalizeRecoveryCode('ABC0DE-IO1')).toBe('ABCDE');
    expect(normalizeRecoveryCode('ABCL2')).toBe('ABCL2'); // L is a real alphabet character
  });

  it('NFKC-folds full-width characters', () => {
    expect(normalizeRecoveryCode('ＡＢＣＤＥ')).toBe('ABCDE'); // full-width ABCDE
  });

  it('handles short input without a trailing separator', () => {
    expect(normalizeRecoveryCode('ABCDEF')).toBe('ABCDE-F');
  });

  it('is total: empty and garbage input never throw', () => {
    expect(normalizeRecoveryCode('')).toBe('');
    expect(normalizeRecoveryCode('----')).toBe('');
    expect(normalizeRecoveryCode(null)).toBe('');
    expect(normalizeRecoveryCode(undefined)).toBe('');
  });

  it('every character of the alphabet round-trips', () => {
    expect(normalizeRecoveryCode(RECOVERY_CODE_ALPHABET.toLowerCase())).toBe(
      normalizeRecoveryCode(RECOVERY_CODE_ALPHABET)
    );
  });
});

describe('describeRecoveryCodeInput', () => {
  it('flags confusable characters without blocking (L is not confusable -- it is valid)', () => {
    const { confusables } = describeRecoveryCodeInput('ABC0DE-IOL1');
    expect(confusables.sort()).toEqual(['0', '1', 'I', 'O']);
  });

  it('reports normalized length', () => {
    expect(describeRecoveryCodeInput('ABCDE-FGHJK').normalizedLength).toBe(10);
  });

  it('reports no confusables for a clean code', () => {
    expect(describeRecoveryCodeInput(generateRecoveryCode()).confusables).toEqual([]);
  });
});
