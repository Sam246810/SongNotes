import { describe, it, expect } from 'vitest';
import { generateSalt, deriveKEK, serializeKdfParams, deserializeKdfParams, PBKDF2_KDF_PARAMS } from '../crypto/kdf';
import {
  generateContentKey, encryptJSON, decryptJSON, wrapContentKey, unwrapContentKey,
  computeDekVerifier, checkDekVerifier,
} from '../crypto/envelope';
import { establishDEK, getDEK, isUnlocked, clearSession } from '../crypto/keyManager';
import {
  createAccountKeys,
  generateRecoveryCode,
  unlockWithPassphrase,
  unlockWithRecoveryCode,
  rewrapWithNewPassphrase,
  migrateWrapIfNeeded,
  regenerateRecoveryWrap,
} from '../crypto/accountKeys';

describe('kdf: deriveKEK', () => {
  it('derives the same key for the same passphrase + salt', async () => {
    const salt = generateSalt();
    const kek1 = await deriveKEK('correct horse battery staple', salt);
    const kek2 = await deriveKEK('correct horse battery staple', salt);

    // Prove equivalence indirectly: wrap a key with kek1, unwrap with kek2.
    const contentKey = await generateContentKey();
    const wrapped = await wrapContentKey(kek1, contentKey);
    const unwrapped = await unwrapContentKey(kek2, wrapped);
    expect(unwrapped).toBeTruthy();

    // And round-trip content through it to be sure it's really the same key.
    const envelope = await encryptJSON(unwrapped, { hello: 'world' });
    const decrypted = await decryptJSON(contentKey, envelope);
    expect(decrypted).toEqual({ hello: 'world' });
  });

  it('derives a different key for a different passphrase', async () => {
    const salt = generateSalt();
    const kekA = await deriveKEK('passphrase-A', salt);
    const kekB = await deriveKEK('passphrase-B', salt);

    const contentKey = await generateContentKey();
    const wrapped = await wrapContentKey(kekA, contentKey);
    await expect(unwrapContentKey(kekB, wrapped)).rejects.toThrow();
  });

  it('derives a different key for a different salt', async () => {
    const kekA = await deriveKEK('same passphrase', generateSalt());
    const kekB = await deriveKEK('same passphrase', generateSalt());

    const contentKey = await generateContentKey();
    const wrapped = await wrapContentKey(kekA, contentKey);
    await expect(unwrapContentKey(kekB, wrapped)).rejects.toThrow();
  });

  it('round-trips KDF params through (de)serialization, defaulting to Argon2id', () => {
    const salt = generateSalt();
    const serialized = serializeKdfParams(salt);
    expect(serialized.salt).toEqual(expect.any(String));
    expect(serialized.name).toBe('Argon2id');
    expect(serialized.memorySize).toBe(65536);
    expect(serialized.iterations).toBe(3);
    expect(serialized.parallelism).toBe(1);

    const deserialized = deserializeKdfParams(serialized);
    expect(deserialized.salt).toBeInstanceOf(Uint8Array);
    expect(deserialized.salt).toEqual(salt);
  });

  it('still derives via the PBKDF2 reader path for old-style params', async () => {
    const salt = generateSalt();
    const kek1 = await deriveKEK('correct horse battery staple', salt, PBKDF2_KDF_PARAMS);
    const kek2 = await deriveKEK('correct horse battery staple', salt, PBKDF2_KDF_PARAMS);

    const contentKey = await generateContentKey();
    const wrapped = await wrapContentKey(kek1, contentKey);
    const unwrapped = await unwrapContentKey(kek2, wrapped);
    const envelope = await encryptJSON(unwrapped, { hello: 'world' });
    expect(await decryptJSON(contentKey, envelope)).toEqual({ hello: 'world' });
  });
});

describe('envelope: DEK verifier', () => {
  it('confirms the right DEK without touching wrapped content', async () => {
    const dek = await generateContentKey();
    const verifier = await computeDekVerifier(dek);
    expect(await checkDekVerifier(dek, verifier)).toBe(true);
  });

  it('rejects the wrong DEK', async () => {
    const dek = await generateContentKey();
    const otherDek = await generateContentKey();
    const verifier = await computeDekVerifier(dek);
    expect(await checkDekVerifier(otherDek, verifier)).toBe(false);
  });
});

describe('envelope: content encryption', () => {
  it('round-trips a JSON value through encrypt/decrypt', async () => {
    const key = await generateContentKey();
    const song = { title: 'My Song', lines: [{ chords: 'Am', lyrics: 'hello' }] };
    const envelope = await encryptJSON(key, song);

    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe('AES-GCM');
    expect(envelope.iv).toEqual(expect.any(String));
    expect(envelope.ct).toEqual(expect.any(String));

    const decrypted = await decryptJSON(key, envelope);
    expect(decrypted).toEqual(song);
  });

  it('never leaks the plaintext into the envelope', async () => {
    const key = await generateContentKey();
    const secretTitle = 'super-secret-title-xyz';
    const envelope = await encryptJSON(key, { title: secretTitle });
    expect(JSON.stringify(envelope)).not.toContain(secretTitle);
  });

  it('fails to decrypt with the wrong key (AEAD tag mismatch)', async () => {
    const key1 = await generateContentKey();
    const key2 = await generateContentKey();
    const envelope = await encryptJSON(key1, { data: 'secret' });
    await expect(decryptJSON(key2, envelope)).rejects.toThrow();
  });

  it('fails to decrypt a tampered ciphertext', async () => {
    const key = await generateContentKey();
    const envelope = await encryptJSON(key, { data: 'secret' });
    // Flip a character in the ciphertext.
    const tampered = { ...envelope, ct: envelope.ct.slice(0, -4) + (envelope.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA') };
    await expect(decryptJSON(key, tampered)).rejects.toThrow();
  });

  it('never reuses an IV across many encryptions with the same key', async () => {
    const key = await generateContentKey();
    const ivs = new Set();
    for (let i = 0; i < 50; i++) {
      const envelope = await encryptJSON(key, { i });
      expect(ivs.has(envelope.iv)).toBe(false);
      ivs.add(envelope.iv);
    }
    expect(ivs.size).toBe(50);
  });
});

describe('envelope: key wrapping', () => {
  it('wraps and unwraps a content key with a KEK', async () => {
    const salt = generateSalt();
    const kek = await deriveKEK('song-password-123', salt);
    const ck = await generateContentKey();

    const wrapped = await wrapContentKey(kek, ck);
    expect(wrapped.wrapped).toEqual(expect.any(String));
    expect(wrapped.iv).toEqual(expect.any(String));

    const unwrapped = await unwrapContentKey(kek, wrapped);
    // Prove it's functionally the same key via a round trip.
    const envelope = await encryptJSON(ck, { ok: true });
    const decrypted = await decryptJSON(unwrapped, envelope);
    expect(decrypted).toEqual({ ok: true });
  });

  it('rejects unwrapping with the wrong KEK', async () => {
    const ck = await generateContentKey();
    const kekA = await deriveKEK('right-password', generateSalt());
    const kekB = await deriveKEK('wrong-password', generateSalt());
    const wrapped = await wrapContentKey(kekA, ck);
    await expect(unwrapContentKey(kekB, wrapped)).rejects.toThrow();
  });
});

describe('keyManager: in-memory session', () => {
  it('starts locked and reflects establish/clear', async () => {
    clearSession();
    expect(isUnlocked()).toBe(false);
    expect(getDEK()).toBeNull();

    const dek = await generateContentKey();
    establishDEK(dek);
    expect(isUnlocked()).toBe(true);
    expect(getDEK()).toBe(dek);

    clearSession();
    expect(isUnlocked()).toBe(false);
    expect(getDEK()).toBeNull();
  });

});

describe('accountKeys: envelope-encryption key hierarchy', () => {
  it('unlocks the same DEK via either the passphrase or the recovery code', async () => {
    const passphrase = 'my account passphrase';
    const recoveryCode = generateRecoveryCode();
    const { dek, envelope } = await createAccountKeys(passphrase, recoveryCode);

    const viaPassphrase = await unlockWithPassphrase(envelope, passphrase);
    const viaRecovery = await unlockWithRecoveryCode(envelope, recoveryCode);

    // Prove both unlocked keys are functionally identical to the original DEK.
    const probe = { secret: 'proves-same-key' };
    const envelopeCt = await encryptJSON(dek, probe);
    expect(await decryptJSON(viaPassphrase, envelopeCt)).toEqual(probe);
    expect(await decryptJSON(viaRecovery, envelopeCt)).toEqual(probe);
  });

  it('rejects the wrong passphrase', async () => {
    const { envelope } = await createAccountKeys('right-passphrase', generateRecoveryCode());
    await expect(unlockWithPassphrase(envelope, 'wrong-passphrase')).rejects.toThrow();
  });

  it('rejects the wrong recovery code', async () => {
    const { envelope } = await createAccountKeys('a-passphrase', generateRecoveryCode());
    await expect(unlockWithRecoveryCode(envelope, 'WRONG-CODE-000-000-000')).rejects.toThrow();
  });

  it('generates recovery codes that look distinct and reasonably long', () => {
    const a = generateRecoveryCode();
    const b = generateRecoveryCode();
    expect(a).not.toBe(b);
    expect(a.replace(/-/g, '').length).toBe(20);
  });

  it('rewrapWithNewPassphrase lets a new passphrase unlock the same DEK, old one no longer works', async () => {
    const recoveryCode = generateRecoveryCode();
    const { dek, envelope } = await createAccountKeys('old-passphrase', recoveryCode);

    const newEnvelope = await rewrapWithNewPassphrase(envelope, dek, 'new-passphrase');

    const viaNewPassphrase = await unlockWithPassphrase(newEnvelope, 'new-passphrase');
    const probe = { still: 'works' };
    const envelopeCt = await encryptJSON(dek, probe);
    expect(await decryptJSON(viaNewPassphrase, envelopeCt)).toEqual(probe);

    await expect(unlockWithPassphrase(newEnvelope, 'old-passphrase')).rejects.toThrow();
    // Recovery code still unlocks the same DEK — untouched by the passphrase reset.
    const viaRecovery = await unlockWithRecoveryCode(newEnvelope, recoveryCode);
    expect(await decryptJSON(viaRecovery, envelopeCt)).toEqual(probe);
  });

  it('regenerateRecoveryWrap mints a new code, old code stops working, passphrase untouched', async () => {
    const oldCode = generateRecoveryCode();
    const { dek, envelope } = await createAccountKeys('a-passphrase', oldCode);

    const { envelope: newEnvelope, recoveryCode: newCode } = await regenerateRecoveryWrap(envelope, dek);
    expect(newCode).not.toBe(oldCode);

    // dekId and verifier are unchanged -- this is a same-DEK operation, not a rotation.
    expect(newEnvelope.dekId).toBe(envelope.dekId);
    expect(newEnvelope.verifier).toEqual(envelope.verifier);

    const probe = { still: 'works' };
    const envelopeCt = await encryptJSON(dek, probe);

    // New code unlocks the same DEK.
    const viaNewCode = await unlockWithRecoveryCode(newEnvelope, newCode);
    expect(await decryptJSON(viaNewCode, envelopeCt)).toEqual(probe);

    // Old code no longer works against the new envelope.
    await expect(unlockWithRecoveryCode(newEnvelope, oldCode)).rejects.toThrow();

    // Passphrase wrap is completely untouched -- the account password still works.
    const viaPassphrase = await unlockWithPassphrase(newEnvelope, 'a-passphrase');
    expect(await decryptJSON(viaPassphrase, envelopeCt)).toEqual(probe);
  });

  it('regenerateRecoveryWrap upgrades a v1 envelope to v2 as a side effect', async () => {
    const passphrase = 'legacy-passphrase';
    const oldCode = generateRecoveryCode();
    const passSalt = generateSalt();
    const recoverySalt = generateSalt();
    const dek = await generateContentKey();
    const passKek = await deriveKEK(passphrase, passSalt, PBKDF2_KDF_PARAMS);
    const recoveryKek = await deriveKEK(oldCode, recoverySalt, PBKDF2_KDF_PARAMS);
    const v1Envelope = {
      v: 1,
      passphrase: { kdf: serializeKdfParams(passSalt, PBKDF2_KDF_PARAMS), wrapped: await wrapContentKey(passKek, dek) },
      recovery: { kdf: serializeKdfParams(recoverySalt, PBKDF2_KDF_PARAMS), wrapped: await wrapContentKey(recoveryKek, dek) },
    };

    const { envelope: upgraded, recoveryCode: newCode } = await regenerateRecoveryWrap(v1Envelope, dek);
    expect(upgraded.v).toBe(2);
    expect(upgraded.dekId).toEqual(expect.any(String));
    expect(upgraded.verifier).toBeTruthy();

    const probe = { still: 'works' };
    const envelopeCt = await encryptJSON(dek, probe);
    const viaNewCode = await unlockWithRecoveryCode(upgraded, newCode);
    expect(await decryptJSON(viaNewCode, envelopeCt)).toEqual(probe);
    // The old (v1, PBKDF2) passphrase wrap is carried over verbatim and still works.
    const viaPassphrase = await unlockWithPassphrase(upgraded, passphrase);
    expect(await decryptJSON(viaPassphrase, envelopeCt)).toEqual(probe);
  });

  it('creates a v2 envelope: wraps[] list, dekId, verifier, no v1 fixed fields', async () => {
    const { envelope } = await createAccountKeys('a-passphrase', generateRecoveryCode());
    expect(envelope.v).toBe(2);
    expect(envelope.alg).toBe('AES-256-GCM');
    expect(envelope.dekId).toEqual(expect.any(String));
    expect(envelope.dekId.length).toBeGreaterThan(0);
    expect(envelope.passphrase).toBeUndefined();
    expect(envelope.recovery).toBeUndefined();

    expect(envelope.wraps).toHaveLength(2);
    const pass = envelope.wraps.find((w) => w.type === 'passphrase');
    const recovery = envelope.wraps.find((w) => w.type === 'recovery-code');
    expect(pass.id).toBe('pass');
    expect(pass.kdf.name).toBe('Argon2id');
    expect(pass.iv).toEqual(expect.any(String));
    expect(pass.ct).toEqual(expect.any(String));
    expect(recovery.id).toBe('recovery');
    expect(recovery.kdf.name).toBe('Argon2id');

    expect(envelope.verifier.iv).toEqual(expect.any(String));
    expect(envelope.verifier.ct).toEqual(expect.any(String));
  });

  it('reads a legacy v1 envelope ({v:1, passphrase, recovery} fixed fields)', async () => {
    // Hand-built in the old shape rather than produced by this version's own
    // createAccountKeys, since nothing in this codebase writes v1 anymore —
    // this is standing in for an envelope stored server-side before the v2 change.
    const passphrase = 'legacy-passphrase';
    const recoveryCode = generateRecoveryCode();
    const dek = await generateContentKey();

    const passSalt = generateSalt();
    const passKek = await deriveKEK(passphrase, passSalt, PBKDF2_KDF_PARAMS);
    const wrappedByPassphrase = await wrapContentKey(passKek, dek);

    const recoverySalt = generateSalt();
    const recoveryKek = await deriveKEK(recoveryCode, recoverySalt, PBKDF2_KDF_PARAMS);
    const wrappedByRecovery = await wrapContentKey(recoveryKek, dek);

    const v1Envelope = {
      v: 1,
      passphrase: { kdf: serializeKdfParams(passSalt, PBKDF2_KDF_PARAMS), wrapped: wrappedByPassphrase },
      recovery: { kdf: serializeKdfParams(recoverySalt, PBKDF2_KDF_PARAMS), wrapped: wrappedByRecovery },
    };

    const viaPassphrase = await unlockWithPassphrase(v1Envelope, passphrase);
    const viaRecovery = await unlockWithRecoveryCode(v1Envelope, recoveryCode);
    const probe = { legacy: 'still readable' };
    const envelopeCt = await encryptJSON(dek, probe);
    expect(await decryptJSON(viaPassphrase, envelopeCt)).toEqual(probe);
    expect(await decryptJSON(viaRecovery, envelopeCt)).toEqual(probe);

    // rewrapWithNewPassphrase upgrades a v1 envelope to v2 as a side effect.
    const upgraded = await rewrapWithNewPassphrase(v1Envelope, dek, 'new-passphrase');
    expect(upgraded.v).toBe(2);
    expect(upgraded.wraps).toHaveLength(2);
    const stillViaRecovery = await unlockWithRecoveryCode(upgraded, recoveryCode);
    expect(await decryptJSON(stillViaRecovery, envelopeCt)).toEqual(probe);
  });

  it('migrateWrapIfNeeded rewraps a PBKDF2 v2 wrap to Argon2id, leaves an up-to-date one alone', async () => {
    const passphrase = 'a-passphrase';
    const { dek, envelope } = await createAccountKeys(passphrase, generateRecoveryCode());

    // Force the passphrase wrap onto the old KDF, as if it predated the Argon2id switch.
    const oldSalt = generateSalt();
    const oldKek = await deriveKEK(passphrase, oldSalt, PBKDF2_KDF_PARAMS);
    const oldWrapped = await wrapContentKey(oldKek, dek);
    const downgraded = {
      ...envelope,
      wraps: envelope.wraps.map((w) => (w.type === 'passphrase'
        ? { ...w, kdf: serializeKdfParams(oldSalt, PBKDF2_KDF_PARAMS), iv: oldWrapped.iv, ct: oldWrapped.wrapped }
        : w)),
    };

    const { envelope: migrated, migrated: didMigrate } = await migrateWrapIfNeeded(downgraded, 'passphrase', passphrase, dek);
    expect(didMigrate).toBe(true);
    const newPassWrap = migrated.wraps.find((w) => w.type === 'passphrase');
    expect(newPassWrap.kdf.name).toBe('Argon2id');
    const viaPassphrase = await unlockWithPassphrase(migrated, passphrase);
    const probe = { after: 'migration' };
    const envelopeCt = await encryptJSON(dek, probe);
    expect(await decryptJSON(viaPassphrase, envelopeCt)).toEqual(probe);

    const { migrated: noOpMigrate } = await migrateWrapIfNeeded(migrated, 'passphrase', passphrase, dek);
    expect(noOpMigrate).toBe(false);
  });
});
