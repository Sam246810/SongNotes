import { describe, it, expect } from 'vitest';
import { generateSalt, deriveKEK, serializeKdfParams, deserializeKdfParams } from '../crypto/kdf';
import { generateContentKey, encryptJSON, decryptJSON, wrapContentKey, unwrapContentKey } from '../crypto/envelope';
import { establishDEK, getDEK, isUnlocked, clearSession, setUnlockedSongKey, getUnlockedSongKey, clearUnlockedSongKey } from '../crypto/keyManager';

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

  it('round-trips KDF params through (de)serialization', () => {
    const salt = generateSalt();
    const serialized = serializeKdfParams(salt);
    expect(serialized.salt).toEqual(expect.any(String));
    expect(serialized.iterations).toBe(600000);
    expect(serialized.name).toBe('PBKDF2');
    expect(serialized.hash).toBe('SHA-256');

    const deserialized = deserializeKdfParams(serialized);
    expect(deserialized.salt).toBeInstanceOf(Uint8Array);
    expect(deserialized.salt).toEqual(salt);
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

  it('tracks unlocked per-song keys independently of the DEK', async () => {
    clearSession();
    const songKey = await generateContentKey();
    setUnlockedSongKey('song-1', songKey);
    expect(getUnlockedSongKey('song-1')).toBe(songKey);
    expect(getUnlockedSongKey('song-2')).toBeNull();

    clearUnlockedSongKey('song-1');
    expect(getUnlockedSongKey('song-1')).toBeNull();
  });

  it('clearSession wipes both the DEK and all unlocked song keys', async () => {
    clearSession();
    establishDEK(await generateContentKey());
    setUnlockedSongKey('song-1', await generateContentKey());

    clearSession();
    expect(getDEK()).toBeNull();
    expect(getUnlockedSongKey('song-1')).toBeNull();
  });
});
