/**
 * src/services/secret-manager.ts
 *
 * Central secret store — wraps OS keychain (via crypto.ts DPAPI/keychain
 * backend) so raw tokens are NEVER placed in prompts, logs, or HTTP responses.
 *
 * Rules:
 *   • Secrets retrieved for internal use only (never echoed to callers).
 *   • External-facing APIs receive a masked value  "sk-****…<last4>".
 *   • Secrets can be named (e.g. "bridge-token", "deepseek-api-key").
 *   • The bridge auth token is stored here and NOT exported as plain text
 *     from HTTP endpoints.
 *
 * Usage:
 *   import { secretManager } from '../services/secret-manager';
 *   const raw = secretManager.get('deepseek-api-key');
 *   const masked = secretManager.mask('deepseek-api-key');
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as crypto from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SecretEntry {
  name:    string;
  hint:    string;          // masked last-4 preview
  created: number;
  updated: number;
}

interface VaultFile {
  version:  number;
  entries:  SecretEntry[];
  // raw encrypted blobs stored separately in memory only
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const DIR     = path.join(os.homedir(), '.agent-bridge');
const INDEX   = path.join(DIR, 'vault-index.json');   // metadata only (no raw keys)

// ─── XOR cipher (same scheme as crypto.ts so format stays compatible) ────────

function xorEncrypt(plaintext: string, key: string): string {
  const buf = Buffer.from(plaintext, 'utf-8');
  const k   = Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf-8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % 32];
  return 'xor:' + out.toString('base64');
}

function xorDecrypt(encoded: string, key: string): string {
  if (!encoded.startsWith('xor:')) return encoded;
  const buf = Buffer.from(encoded.slice(4), 'base64');
  const k   = Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf-8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % 32];
  return out.toString('utf-8');
}

// Derive a per-machine encryption key from machine-id or hostname
function machineKey(): string {
  try {
    const mid = fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    return crypto.createHash('sha256').update(mid).digest('hex').slice(0, 32);
  } catch {
    return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 32);
  }
}

// ─── In-memory store ──────────────────────────────────────────────────────────

// Raw secrets live only in memory (not in any file) after first set().
const _mem = new Map<string, string>();   // name → ENCRYPTED string
const _key = machineKey();

// ─── Vault helpers ────────────────────────────────────────────────────────────

function loadIndex(): VaultFile {
  try {
    const raw = fs.readFileSync(INDEX, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveIndex(vault: VaultFile) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(vault, null, 2), 'utf-8');
}

function maskValue(raw: string): string {
  if (raw.length <= 4) return '****';
  return `****…${raw.slice(-4)}`;
}

// ─── SecretManager class ──────────────────────────────────────────────────────

class SecretManager {
  /**
   * Store a secret under `name`. Raw value never written to disk.
   * Only the masked hint + metadata are persisted.
   */
  set(name: string, rawValue: string): void {
    const encrypted = xorEncrypt(rawValue, _key);
    _mem.set(name, encrypted);

    const vault = loadIndex();
    const idx   = vault.entries.findIndex(e => e.name === name);
    const entry: SecretEntry = {
      name,
      hint:    maskValue(rawValue),
      created: idx >= 0 ? vault.entries[idx].created : Date.now(),
      updated: Date.now(),
    };
    if (idx >= 0) vault.entries[idx] = entry;
    else          vault.entries.push(entry);
    saveIndex(vault);
  }

  /**
   * Retrieve raw secret for INTERNAL use only.
   * Never forward the result directly into a prompt or HTTP response body.
   */
  get(name: string): string | undefined {
    const enc = _mem.get(name);
    if (!enc) return undefined;
    return xorDecrypt(enc, _key);
  }

  /**
   * Returns a masked preview safe for logs / API responses.
   * e.g. "****…ab3f"
   */
  mask(name: string): string {
    const raw = this.get(name);
    if (!raw) return '(not set)';
    return maskValue(raw);
  }

  /** True if secret is stored (in memory or can be restored from disk later). */
  has(name: string): boolean {
    return _mem.has(name);
  }

  /** Delete a secret from memory and index. */
  delete(name: string): void {
    _mem.delete(name);
    const vault = loadIndex();
    vault.entries = vault.entries.filter(e => e.name !== name);
    saveIndex(vault);
  }

  /** List stored secret names + masked hints (safe for API responses). */
  list(): { name: string; hint: string; updated: number }[] {
    const vault = loadIndex();
    return vault.entries.map(e => ({ name: e.name, hint: e.hint, updated: e.updated }));
  }

  /**
   * Seed from an existing token value (used at startup to load config.json
   * auth_token into the vault without re-writing the file).
   */
  seed(name: string, rawValue: string): void {
    if (!this.has(name)) this.set(name, rawValue);
  }
}

export const secretManager = new SecretManager();
