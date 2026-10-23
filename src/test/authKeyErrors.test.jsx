import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { useContext } from 'react';
import { render, act } from '@testing-library/react';
import { argon2id } from 'hash-wasm';
import {
  createAccountKeys, unlockWithPassphrase, unlockWithRecoveryCode, KeyMismatchError, isKeyMismatchError,
} from '../crypto/accountKeys';
import { establishDEK } from '../crypto/keyManager';

/**
 * Only a genuine wrong-key unwrap may reach LoginPage's mismatch UI (recovery
 * code, then "start fresh", which purges encrypted songs). Environment
 * failures — a CSP once blocked hash-wasm's WebAssembly and every sign-in
 * reported "your saved encryption key doesn't match this password" — must
 * surface as a plain, retryable error instead.
 */

// Real Argon2id by default; individual tests make it fail the way a CSP block does.
vi.mock('hash-wasm', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, argon2id: vi.fn(actual.argon2id) };
});

const supabaseMock = vi.hoisted(() => ({
  auth: {
    getSession: () => Promise.resolve({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithPassword: () => Promise.resolve({ data: { user: { id: 'u1' }, session: { user: { id: 'u1' } } }, error: null }),
    signUp: () => Promise.resolve({ data: { user: { id: 'u1' }, session: { user: { id: 'u1' } } }, error: null }),
    signOut: () => Promise.resolve({ error: null }),
  },
}));
vi.mock('../lib/supabaseClient', () => ({ supabase: supabaseMock, isSupabaseConfigured: true }));

// What SupabaseUserKeysAdapter would read/write; reset per test.
const keys = vi.hoisted(() => ({ row: null, createError: null }));
vi.mock('../lib/userKeysAdapter', () => ({
  SupabaseUserKeysAdapter: class {
    async get() { return keys.row; }
    async create(envelope) {
      if (keys.createError) throw keys.createError;
      keys.row = { envelope, rev: 1 };
      return 1;
    }
    async update(envelope, rev) { keys.row = { envelope, rev: rev + 1 }; }
  },
}));

vi.mock('../crypto/keyManager', () => ({
  establishDEK: vi.fn(async () => {}),
  clearSession: vi.fn(async () => {}),
}));

vi.mock('../store/songsRepository', () => ({ clearAccountLocalCaches: () => {} }));

const { default: AuthProvider } = await import('../auth/AuthProvider');
const { AuthContext } = await import('../auth/AuthContext');

const PASSWORD = 'correct-horse-1';
const NOT_A_PASSWORD_PROBLEM = /isn't a (wrong-)?password (problem|issue)/;
let stored; // { envelope, recoveryCode } created once with real Argon2id

function cspBlockedWasm() {
  return new WebAssembly.CompileError(
    "WebAssembly.instantiate(): Refused to compile or instantiate WebAssembly module because 'wasm-unsafe-eval' is not an allowed source"
  );
}

async function renderAuth() {
  let auth;
  function Probe() {
    auth = useContext(AuthContext);
    return null;
  }
  await act(async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
  });
  return auth;
}

beforeAll(async () => {
  stored = await createAccountKeys(PASSWORD);
}, 30000);

beforeEach(() => {
  keys.row = { envelope: stored.envelope, rev: 1 };
  keys.createError = null;
  vi.mocked(argon2id).mockClear();
  vi.mocked(establishDEK).mockReset();
  vi.mocked(establishDEK).mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('accountKeys unlock error classification', () => {
  it('a wrong passphrase or recovery code throws KeyMismatchError', async () => {
    await expect(unlockWithPassphrase(stored.envelope, 'wrong-password')).rejects.toBeInstanceOf(KeyMismatchError);
    await expect(unlockWithRecoveryCode(stored.envelope, 'AAAAA-AAAAA-AAAAA-AAAAA')).rejects.toBeInstanceOf(KeyMismatchError);
  });

  it('an Argon2id runtime failure is not a mismatch', async () => {
    vi.mocked(argon2id).mockRejectedValueOnce(cspBlockedWasm());
    const err = await unlockWithPassphrase(stored.envelope, PASSWORD).catch((e) => e);
    expect(err).toBeInstanceOf(WebAssembly.CompileError);
    expect(isKeyMismatchError(err)).toBe(false);
  });

  it('out-of-bounds KDF params are not a mismatch', async () => {
    const envelope = structuredClone(stored.envelope);
    envelope.wraps.find((w) => w.type === 'passphrase').kdf.memorySize = 4194304;
    const err = await unlockWithPassphrase(envelope, PASSWORD).catch((e) => e);
    expect(err.message).toMatch(/Unsupported KDF parameter/);
    expect(isKeyMismatchError(err)).toBe(false);
  });
});

describe('AuthProvider.signIn', () => {
  it('the right password unlocks', async () => {
    const auth = await renderAuth();
    const result = await auth.signIn('a@b.co', PASSWORD);
    expect(result.keyUnlockFailed).toBe(false);
    expect(establishDEK).toHaveBeenCalledOnce();
  });

  it('an envelope that does not match the password reports keyUnlockFailed', async () => {
    const auth = await renderAuth();
    const result = await auth.signIn('a@b.co', 'a-different-password');
    expect(result.keyUnlockFailed).toBe(true);
    expect(establishDEK).not.toHaveBeenCalled();
  });

  it('a WebAssembly CompileError from Argon2id throws a non-mismatch error', async () => {
    vi.mocked(argon2id).mockRejectedValueOnce(cspBlockedWasm());
    const auth = await renderAuth();
    await expect(auth.signIn('a@b.co', PASSWORD)).rejects.toThrow(NOT_A_PASSWORD_PROBLEM);
  });

  it('a KDF bounds error throws a non-mismatch error', async () => {
    const envelope = structuredClone(stored.envelope);
    envelope.wraps.find((w) => w.type === 'passphrase').kdf.iterations = 1000;
    keys.row = { envelope, rev: 1 };
    const auth = await renderAuth();
    await expect(auth.signIn('a@b.co', PASSWORD)).rejects.toThrow(NOT_A_PASSWORD_PROBLEM);
  });

  it('first sign-in: key creation failing throws instead of reporting a mismatch', async () => {
    keys.row = null;
    vi.mocked(argon2id).mockRejectedValueOnce(cspBlockedWasm());
    const auth = await renderAuth();
    await expect(auth.signIn('a@b.co', PASSWORD)).rejects.toThrow(NOT_A_PASSWORD_PROBLEM);
    expect(keys.row).toBeNull();
  });

  it('first sign-in: a network error storing the envelope throws instead of reporting a mismatch', async () => {
    keys.row = null;
    keys.createError = new TypeError('Failed to fetch');
    const auth = await renderAuth();
    await expect(auth.signIn('a@b.co', PASSWORD)).rejects.toThrow(NOT_A_PASSWORD_PROBLEM);
  });
});

describe('AuthProvider.unlockAccountKey', () => {
  it('says "Incorrect password." only for a real mismatch', async () => {
    supabaseMock.auth.getSession = () => Promise.resolve({ data: { session: { user: { id: 'u1' } } } });
    const auth = await renderAuth();
    await expect(auth.unlockAccountKey('a-different-password')).rejects.toThrow('Incorrect password.');
    vi.mocked(argon2id).mockRejectedValueOnce(cspBlockedWasm());
    await expect(auth.unlockAccountKey(PASSWORD)).rejects.toThrow(NOT_A_PASSWORD_PROBLEM);
    supabaseMock.auth.getSession = () => Promise.resolve({ data: { session: null } });
  });
});

describe('AuthProvider.signUp', () => {
  it('reports keySetupFailed (no code) when key creation fails, instead of swallowing it', async () => {
    keys.row = null;
    vi.mocked(argon2id).mockRejectedValueOnce(cspBlockedWasm());
    const auth = await renderAuth();
    const result = await auth.signUp('a@b.co', PASSWORD);
    expect(result.keySetupFailed).toBe(true);
    expect(result.recoveryCode).toBeNull();
    expect(keys.row).toBeNull();
  });

  it('still returns the recovery code if the envelope was stored but establishing the DEK failed', async () => {
    keys.row = null;
    vi.mocked(establishDEK).mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    const auth = await renderAuth();
    const result = await auth.signUp('a@b.co', PASSWORD);
    expect(result.keySetupFailed).toBe(true);
    expect(result.recoveryCode).toBeTruthy();
    expect(keys.row).not.toBeNull();
  });

  it('a clean signup reports no failure', async () => {
    keys.row = null;
    const auth = await renderAuth();
    const result = await auth.signUp('a@b.co', PASSWORD);
    expect(result.keySetupFailed).toBe(false);
    expect(result.recoveryCode).toBeTruthy();
  });
});
