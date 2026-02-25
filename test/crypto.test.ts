/**
 * test/crypto.test.ts
 *
 * Tests for the platform-aware credential-encryption module.
 *
 * Strategy:
 *   - selfTest() exercises the full round-trip on the current platform.
 *   - XOR path is exercised explicitly by testing the Linux fallback logic
 *     (replicated inline so tests run without OS dependencies).
 *   - Tests never log plaintext tokens.
 */
import * as os     from 'os';
import * as crypto from 'crypto';
import { encryptSecret, decryptSecret, deleteSecret, selfTest } from '../src/crypto';

const PLATFORM = os.platform();

// ─── XOR logic replicated (mirrors crypto.ts) ─────────────────────────────

function xorWithKey(plaintext: string): string {
  const machineKey = crypto.createHash('sha256').update(os.hostname()).digest();
  const ptBuf  = Buffer.from(plaintext, 'utf-8');
  const xored  = Buffer.allocUnsafe(ptBuf.length);
  for (let i = 0; i < ptBuf.length; i++) {
    xored[i] = ptBuf[i] ^ machineKey[i % machineKey.length];
  }
  return `xor:${xored.toString('base64')}`;
}

function xorDecode(enc: string): string {
  if (!enc.startsWith('xor:')) throw new Error('Not an XOR blob');
  const machineKey = crypto.createHash('sha256').update(os.hostname()).digest();
  const xored  = Buffer.from(enc.slice(4), 'base64');
  const result = Buffer.allocUnsafe(xored.length);
  for (let i = 0; i < xored.length; i++) {
    result[i] = xored[i] ^ machineKey[i % machineKey.length];
  }
  return result.toString('utf-8');
}

// ─── XOR unit tests ──────────────────────────────────────────────────────────

describe('XOR encryption logic (platform-independent)', () => {
  it('round-trips a short string', () => {
    const v = 'my-secret-token-12345';
    const enc = xorWithKey(v);
    expect(enc).toMatch(/^xor:/);
    expect(xorDecode(enc)).toBe(v);
  });

  it('round-trips an empty string', () => {
    const enc = xorWithKey('');
    expect(xorDecode(enc)).toBe('');
  });

  it('round-trips unicode content', () => {
    const v = '🔐 süper sécret 日本語';
    expect(xorDecode(xorWithKey(v))).toBe(v);
  });

  it('round-trips a long token (256 chars)', () => {
    const v = 'a'.repeat(256);
    expect(xorDecode(xorWithKey(v))).toBe(v);
  });

  it('round-trips a UUID v4 token', () => {
    const v = 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(xorDecode(xorWithKey(v))).toBe(v);
  });

  it('produces a different cipher for different plaintexts', () => {
    const a = xorWithKey('secret-a');
    const b = xorWithKey('secret-b');
    expect(a).not.toBe(b);
  });

  it('is deterministic on the same machine', () => {
    const v = 'deterministic-test';
    expect(xorWithKey(v)).toBe(xorWithKey(v));
  });

  it('decryptSecret handles xor: prefix correctly', () => {
    const plaintext = 'round-trip-via-decrypt';
    const enc       = xorWithKey(plaintext);
    expect(decryptSecret(enc, 'test-label')).toBe(plaintext);
  });
});

// ─── Full platform round-trip ─────────────────────────────────────────────────

describe('encryptSecret / decryptSecret (native platform)', () => {
  const label = `test-cred-${Date.now()}`;

  afterAll(() => {
    // Clean up keychain entries on macOS
    try { deleteSecret(label); } catch {}
  });

  it('selfTest() returns true on current platform', () => {
    // selfTest does: encrypt → decrypt → compare → delete
    const ok = selfTest('test-value-abc123', label + '-self');
    expect(ok).toBe(true);
  }, 15_000); // generous timeout for PowerShell / Keychain

  it('round-trips a realistic API key', () => {
    const key = 'sk-abcdefghij1234567890ABCDEFGHIJ1234567890abcdef';
    try {
      const enc = encryptSecret(key, label);
      expect(enc).not.toBe(key); // must not store plaintext
      const dec = decryptSecret(enc, label);
      expect(dec).toBe(key);
    } finally {
      try { deleteSecret(label); } catch {}
    }
  }, 15_000);

  it('encrypts tokens differently from passwords (different labels)', () => {
    const tokenLabel = label + '-token';
    const passLabel  = label + '-pass';
    const tokenVal   = 'Bearer eyJhbGciOiJIUzI1NiJ9';
    const passVal    = 'P@ssw0rd!';
    try {
      const te = encryptSecret(tokenVal, tokenLabel);
      const pe = encryptSecret(passVal,  passLabel);
      // On XOR platform, output depends on label + machine key + value, so they'll differ
      // On DPAPI, output is always different due to random entropy
      // Either way, the decrypted values must be correct
      expect(decryptSecret(te, tokenLabel)).toBe(tokenVal);
      expect(decryptSecret(pe, passLabel)).toBe(passVal);
    } finally {
      try { deleteSecret(tokenLabel); } catch {}
      try { deleteSecret(passLabel);  } catch {}
    }
  }, 15_000);

  it('empty string survives round-trip', () => {
    const emptyLabel = label + '-empty';
    try {
      const enc = encryptSecret('', emptyLabel);
      expect(decryptSecret(enc, emptyLabel)).toBe('');
    } finally {
      try { deleteSecret(emptyLabel); } catch {}
    }
  }, 15_000);

  it('does not store prefix-prefixed values as plaintext on Linux', () => {
    if (PLATFORM !== 'linux') return; // covered by DPAPI/Keychain tests above
    const val = 'linux-plaintext-should-not-appear';
    const enc = encryptSecret(val, label + '-linux');
    expect(enc).not.toBe(val);
    expect(enc).toMatch(/^xor:/);
  });

  it('Windows DPAPI blob starts with dpapi: prefix', () => {
    if (PLATFORM !== 'win32') return;
    const enc = encryptSecret('win32-test', label + '-win');
    expect(enc).toMatch(/^dpapi:/);
    try { deleteSecret(label + '-win'); } catch {}
  }, 10_000);

  it('macOS Keychain blob starts with keychain: prefix', () => {
    if (PLATFORM !== 'darwin') return;
    const enc = encryptSecret('macos-test', label + '-mac');
    expect(enc).toMatch(/^keychain:/);
    try { deleteSecret(label + '-mac'); } catch {}
  }, 10_000);
});

// ─── deleteSecret ──────────────────────────────────────────────────────────

describe('deleteSecret()', () => {
  it('does not throw when removing a non-existent key', () => {
    expect(() => deleteSecret('definitely-not-a-real-key-' + Date.now())).not.toThrow();
  });
});
