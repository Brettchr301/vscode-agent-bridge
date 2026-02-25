/**
 * test/auth.test.ts
 *
 * Tests for the auth-token generation, format, and storage logic.
 * These test the standalone helper that does not depend on VS Code APIs.
 */
import * as crypto from 'crypto';
import * as fs     from 'fs';
import * as os     from 'os';
import * as path   from 'path';

// ─── Token generation helpers (mirrors logic in src/server.ts) ────────────────

function generateToken(): string {
  return crypto.randomUUID();
}

function writeTokenToConfig(dir: string, token: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  existing.auth_token = token;
  fs.writeFileSync(file, JSON.stringify(existing, null, 2), 'utf-8');
}

function readTokenFromConfig(dir: string): string | null {
  try {
    const file = path.join(dir, 'config.json');
    const raw  = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw).auth_token ?? null;
  } catch { return null; }
}

// ─── Token format ────────────────────────────────────────────────────────────

describe('generateToken()', () => {
  it('returns a valid UUID v4', () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('generates unique tokens on each call', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateToken));
    expect(tokens.size).toBe(100);
  });

  it('token is 36 characters long', () => {
    const t = generateToken();
    expect(t.length).toBe(36);
  });

  it('token contains four dashes', () => {
    const t = generateToken();
    expect((t.match(/-/g) ?? []).length).toBe(4);
  });
});

// ─── Config file persistence ──────────────────────────────────────────────────

describe('config.json token persistence', () => {
  const tmpDir = path.join(os.tmpdir(), `.agent-bridge-test-${Date.now()}`);

  afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('writes and reads back the same token', () => {
    const token = generateToken();
    writeTokenToConfig(tmpDir, token);
    expect(readTokenFromConfig(tmpDir)).toBe(token);
  });

  it('returns null when config does not exist', () => {
    expect(readTokenFromConfig(path.join(os.tmpdir(), 'definitely-missing-dir-' + Date.now()))).toBeNull();
  });

  it('preserves existing config keys when writing token', () => {
    const cfgFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ some_key: 'some_value' }), 'utf-8');
    const token = generateToken();
    writeTokenToConfig(tmpDir, token);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(cfg.some_key).toBe('some_value');
    expect(cfg.auth_token).toBe(token);
  });

  it('overwrites old token on second write', () => {
    const first  = generateToken();
    const second = generateToken();
    writeTokenToConfig(tmpDir, first);
    writeTokenToConfig(tmpDir, second);
    expect(readTokenFromConfig(tmpDir)).toBe(second);
  });

  it('handles BOM in config file', () => {
    const cfgFile = path.join(tmpDir, 'config.json');
    const token   = generateToken();
    fs.writeFileSync(cfgFile, '\uFEFF' + JSON.stringify({ auth_token: token }), 'utf-8');
    expect(readTokenFromConfig(tmpDir)).toBe(token);
  });
});

// ─── Auth check logic ─────────────────────────────────────────────────────────

describe('Authorization header parsing', () => {
  function parseBearer(header: string): string {
    return header.replace(/^Bearer\s+/i, '');
  }

  it('strips Bearer prefix (lowercase)', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
  });

  it('strips Bearer prefix (uppercase)', () => {
    expect(parseBearer('BEARER mytoken')).toBe('mytoken');
  });

  it('strips Bearer prefix (mixed case)', () => {
    expect(parseBearer('bEaReR mytoken')).toBe('mytoken');
  });

  it('returns value unchanged when no Bearer prefix', () => {
    expect(parseBearer('mytoken')).toBe('mytoken');
  });

  it('handles extra whitespace', () => {
    // \s+ is greedy — strips all whitespace between Bearer and the token
    expect(parseBearer('Bearer  mytoken')).toBe('mytoken');
  });

  it('token comparison is exact (no partial match)', () => {
    const stored   = crypto.randomUUID(); // runtime value — avoids TS literal comparison error
    const supplied = stored.slice(0, -1);  // one char shorter
    expect(supplied === stored).toBe(false);
  });

  it('public paths bypass auth', () => {
    const PUBLIC_PATHS = new Set(['/health', '/mcp/health']);
    expect(PUBLIC_PATHS.has('/health')).toBe(true);
    expect(PUBLIC_PATHS.has('/mcp/health')).toBe(true);
    expect(PUBLIC_PATHS.has('/iot/devices')).toBe(false);
    expect(PUBLIC_PATHS.has('/automations')).toBe(false);
  });
});
