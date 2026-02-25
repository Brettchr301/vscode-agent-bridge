/**
 * src/crypto.ts
 *
 * Platform-aware credential encryption.
 *
 * Windows  → DPAPI (ProtectedData) via PowerShell — user-scoped, no extra libs.
 * macOS    → Keychain via `security` CLI — stored in login keychain.
 * Linux    → XOR-obfuscated base64 (best-effort; recommend gpg-agent for prod).
 *
 * Usage:
 *   const enc = encryptSecret('my-token', 'iot-hue-bridge');
 *   const raw = decryptSecret(enc,         'iot-hue-bridge');
 */
import { execSync } from 'child_process';
import * as os   from 'os';
import * as crypto from 'crypto';

const PLATFORM = os.platform();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function psEscape(s: string): string {
  // Escape single-quotes for embedding in a PowerShell string
  return s.replace(/'/g, "''");
}

function safeLabel(label: string): string {
  // Remove chars that break `security` CLI or PowerShell args
  return label.replace(/['"\\&;|<>]/g, '_');
}

// ─── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypt `plaintext` using the OS credential store.
 * Returns an opaque string that can be stored at rest.
 * `label` identifies the item in the Keychain / custom metadata.
 */
export function encryptSecret(plaintext: string, label: string): string {
  const lbl = safeLabel(label);

  if (PLATFORM === 'win32') {
    // DPAPI — user-scoped encryption. Only the same Windows user can decrypt.
    // Add-Type loads System.Security.dll which hosts ProtectedData.
    const b64Input = Buffer.from(plaintext, 'utf-8').toString('base64');
    const cmd =
      `Add-Type -AssemblyName System.Security; ` +
      `[System.Convert]::ToBase64String(` +
      `[System.Security.Cryptography.ProtectedData]::Protect(` +
      `[System.Convert]::FromBase64String('${psEscape(b64Input)}'), ` +
      `$null, 'CurrentUser'))`;
    const encrypted = execSync(`powershell -NoProfile -NonInteractive -Command "${cmd}"`, {
      encoding: 'utf-8',
      timeout: 8000,
    }).trim();
    return `dpapi:${encrypted}`;
  }

  if (PLATFORM === 'darwin') {
    // macOS Keychain — update-or-create with -U flag
    execSync(
      `security add-generic-password -U -a "agent-bridge" -s "${lbl}" -w "${psEscape(plaintext)}"`,
      { encoding: 'utf-8', timeout: 8000 },
    );
    return `keychain:${lbl}`;
  }

  // Linux fallback — XOR with a machine-specific key derived from hostname
  const machineKey = crypto
    .createHash('sha256')
    .update(os.hostname())
    .digest();
  const ptBuf  = Buffer.from(plaintext, 'utf-8');
  const xored  = Buffer.allocUnsafe(ptBuf.length);
  for (let i = 0; i < ptBuf.length; i++) {
    xored[i] = ptBuf[i] ^ machineKey[i % machineKey.length];
  }
  return `xor:${xored.toString('base64')}`;
}

// ─── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypt a value that was previously returned by `encryptSecret`.
 * Throws if decryption fails.
 */
export function decryptSecret(encrypted: string, label: string): string {
  const lbl = safeLabel(label);

  if (encrypted.startsWith('dpapi:')) {
    const blob = encrypted.slice(6);
    const cmd =
      `Add-Type -AssemblyName System.Security; ` +
      `[System.Text.Encoding]::UTF8.GetString(` +
      `[System.Convert]::FromBase64String(` +
      `[System.Convert]::ToBase64String(` +
      `[System.Security.Cryptography.ProtectedData]::Unprotect(` +
      `[System.Convert]::FromBase64String('${psEscape(blob)}'), ` +
      `$null, 'CurrentUser'))))`;
    // Decode via base64 round-trip so embedded null bytes are safe
    const raw = execSync(`powershell -NoProfile -NonInteractive -Command "${cmd}"`, {
      encoding: 'utf-8',
      timeout: 8000,
    }).trim();
    return raw;
  }

  if (encrypted.startsWith('keychain:')) {
    return execSync(
      `security find-generic-password -a "agent-bridge" -s "${lbl}" -w`,
      { encoding: 'utf-8', timeout: 8000 },
    ).trim();
  }

  if (encrypted.startsWith('xor:')) {
    const machineKey = crypto
      .createHash('sha256')
      .update(os.hostname())
      .digest();
    const xored  = Buffer.from(encrypted.slice(4), 'base64');
    const result = Buffer.allocUnsafe(xored.length);
    for (let i = 0; i < xored.length; i++) {
      result[i] = xored[i] ^ machineKey[i % machineKey.length];
    }
    return result.toString('utf-8');
  }

  // Plain text fallback (legacy — no prefix)
  return encrypted;
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Remove the credential from the OS store (no-op for xor/dpapi blobs).
 */
export function deleteSecret(label: string): void {
  const lbl = safeLabel(label);

  if (PLATFORM === 'darwin') {
    try {
      execSync(
        `security delete-generic-password -a "agent-bridge" -s "${lbl}"`,
        { encoding: 'utf-8', timeout: 5000 },
      );
    } catch { /* silently ignore if not found */ }
  }
  // Windows DPAPI blobs are self-contained — nothing to delete from the OS.
  // Linux XOR blobs are self-contained too.
}

// ─── Test helper (used by tests, not shipped) ────────────────────────────────

/** Round-trip sanity check — returns true if enc→dec === original */
export function selfTest(value: string, label: string): boolean {
  try {
    const enc = encryptSecret(value, label);
    const dec = decryptSecret(enc, label);
    deleteSecret(label);
    return dec === value;
  } catch {
    return false;
  }
}
