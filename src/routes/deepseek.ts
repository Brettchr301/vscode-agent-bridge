/**
 * src/routes/deepseek.ts
 *
 * Proxy endpoints for DeepSeek and OpenAI Codex APIs.
 * Stores API keys encrypted at rest via src/crypto.ts.
 *
 * Endpoints:
 *   POST /ai/deepseek/chat         — chat completions (DeepSeek-chat / R1)
 *   POST /ai/deepseek/code         — code generation via deepseek-coder
 *   POST /ai/codex/complete        — OpenAI Codex / GPT-4o completions
 *   POST /ai/codex/edit            — code edit (uses gpt-4o)
 *   GET  /ai/keys                  — list which keys are set (masked)
 *   POST /ai/keys                  — store / update an API key (encrypted)
 *   DELETE /ai/keys/:provider      — remove a key
 *   POST /ai/chat                  — auto-route to best available model
 */
import * as https from 'https';
import * as fs    from 'fs';
import * as path  from 'path';
import * as os    from 'os';
import { RouteContext } from '../types';
import { send }         from '../helpers';
import { encryptSecret, decryptSecret, deleteSecret } from '../crypto';

// ─── Key storage ─────────────────────────────────────────────────────────────

const DATA_DIR    = path.join(os.homedir(), '.agent-bridge');
const KEYS_FILE   = path.join(DATA_DIR, 'ai-keys.json');

type Provider = 'deepseek' | 'openai';

interface KeyEntry { provider: Provider; encrypted: string; added: string; }

let keysCache: KeyEntry[] = [];

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadKeys(): KeyEntry[] {
  try {
    ensureDir();
    if (!fs.existsSync(KEYS_FILE)) return [];
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8').replace(/^\uFEFF/, ''));
  } catch { return []; }
}

function saveKeys() {
  ensureDir();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keysCache, null, 2), 'utf-8');
}

keysCache = loadKeys();

function getKey(provider: Provider): string | null {
  const entry = keysCache.find(k => k.provider === provider);
  if (!entry) return null;
  try { return decryptSecret(entry.encrypted, `ai-key-${provider}`); } catch { return null; }
}

// ─── HTTPS helper ─────────────────────────────────────────────────────────────

function httpsPost(
  host: string,
  path: string,
  apiKey: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const opts: https.RequestOptions = {
      hostname: host,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`,
      },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 200, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode ?? 200, body: { raw: d } }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── DeepSeek helpers ────────────────────────────────────────────────────────

const DS_HOST = 'api.deepseek.com';

async function deepseekChat(
  messages: { role: string; content: string }[],
  model  = 'deepseek-chat',
  opts: Record<string, unknown> = {},
): Promise<unknown> {
  const key = getKey('deepseek');
  if (!key) throw new Error('DeepSeek API key not set. POST /ai/keys with { provider:"deepseek", key:"sk-..." }');
  const payload = {
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens:  opts.max_tokens  ?? 4096,
    stream:      false,
    ...opts,
  };
  const { body } = await httpsPost(DS_HOST, '/v1/chat/completions', key, payload);
  return body;
}

// ─── OpenAI helpers ──────────────────────────────────────────────────────────

const OAI_HOST = 'api.openai.com';

async function openaiChat(
  messages: { role: string; content: string }[],
  model  = 'gpt-4o',
  opts: Record<string, unknown> = {},
): Promise<unknown> {
  const key = getKey('openai');
  if (!key) throw new Error('OpenAI API key not set. POST /ai/keys with { provider:"openai", key:"sk-..." }');
  const payload = {
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens:  opts.max_tokens  ?? 4096,
    ...opts,
  };
  const { body } = await httpsPost(OAI_HOST, '/v1/chat/completions', key, payload);
  return body;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function deepseekRoutes(ctx: RouteContext): Promise<boolean> {
  const { meth, pathStr, b, res } = ctx;

  // GET /ai/keys — list which keys are configured (masked, never plaintext)
  if (meth === 'GET' && pathStr === '/ai/keys') {
    send(res, 200, {
      ok:   true,
      keys: keysCache.map(k => ({
        provider: k.provider,
        set:      true,
        added:    k.added,
      })),
    });
    return true;
  }

  // POST /ai/keys — store or update a key
  if (meth === 'POST' && pathStr === '/ai/keys') {
    const { provider, key: rawKey } = b as { provider: Provider; key: string };
    if (!provider || !rawKey) {
      send(res, 400, { ok: false, error: 'body must have { provider, key }' });
      return true;
    }
    const label     = `ai-key-${provider}`;
    const encrypted = encryptSecret(rawKey, label);
    const idx       = keysCache.findIndex(k => k.provider === provider);
    const entry: KeyEntry = { provider, encrypted, added: new Date().toISOString() };
    if (idx >= 0) keysCache[idx] = entry;
    else keysCache.push(entry);
    saveKeys();
    send(res, 200, { ok: true, provider, message: 'Key stored (encrypted at rest)' });
    return true;
  }

  // DELETE /ai/keys/:provider
  const delMatch = pathStr.match(/^\/ai\/keys\/([^/]+)$/);
  if (meth === 'DELETE' && delMatch) {
    const provider = delMatch[1] as Provider;
    const idx = keysCache.findIndex(k => k.provider === provider);
    if (idx === -1) { send(res, 404, { ok: false, error: 'Key not found' }); return true; }
    deleteSecret(`ai-key-${provider}`);
    keysCache.splice(idx, 1);
    saveKeys();
    send(res, 200, { ok: true, message: `${provider} key removed` });
    return true;
  }

  type Msg = { role: string; content: string };
  const msgs_b = (b.messages as Msg[] | undefined);
  const model_b = () => String(b.model ?? '');
  const opts_b  = (b.options as Record<string, unknown> | undefined) ?? {};

  // POST /ai/deepseek/chat
  if (meth === 'POST' && pathStr === '/ai/deepseek/chat') {
    try {
      const msgs: Msg[] = msgs_b ?? [{ role: 'user', content: String(b.prompt ?? '') }];
      const result = await deepseekChat(msgs, model_b() || 'deepseek-chat', opts_b);
      send(res, 200, { ok: true, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /ai/deepseek/code — deepseek-coder
  if (meth === 'POST' && pathStr === '/ai/deepseek/code') {
    try {
      const msgs: Msg[] = msgs_b ?? [
        { role: 'system', content: 'You are an expert coding assistant. Return only clean, working code.' },
        { role: 'user',   content: String(b.prompt ?? '') },
      ];
      const result = await deepseekChat(msgs, model_b() || 'deepseek-coder', opts_b);
      send(res, 200, { ok: true, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /ai/deepseek/r1 — DeepSeek R1 (reasoning)
  if (meth === 'POST' && pathStr === '/ai/deepseek/r1') {
    try {
      const msgs: Msg[] = msgs_b ?? [{ role: 'user', content: String(b.prompt ?? '') }];
      const result = await deepseekChat(msgs, 'deepseek-reasoner', opts_b);
      send(res, 200, { ok: true, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /ai/codex/complete — GPT-4o code completions (Codex successor)
  if (meth === 'POST' && pathStr === '/ai/codex/complete') {
    try {
      const msgs: Msg[] = msgs_b ?? [
        { role: 'system', content: 'You are GitHub Copilot. Complete the code. Return only valid code without markdown fences.' },
        { role: 'user',   content: String(b.prompt ?? b.code ?? '') },
      ];
      const result = await openaiChat(msgs, model_b() || 'gpt-4o', opts_b);
      send(res, 200, { ok: true, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /ai/codex/edit — code edit with instruction
  if (meth === 'POST' && pathStr === '/ai/codex/edit') {
    try {
      const msgs: Msg[] = [
        { role: 'system', content: 'You are a code editing assistant. Apply the given instruction to the code. Return ONLY the edited code without any explanation.' },
        { role: 'user',   content: `Instruction: ${b.instruction ?? ''}\n\nCode:\n${b.code ?? ''}` },
      ];
      const result = await openaiChat(msgs, model_b() || 'gpt-4o', opts_b);
      send(res, 200, { ok: true, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /ai/chat — auto-route: prefer deepseek if key exists, else openai
  if (meth === 'POST' && pathStr === '/ai/chat') {
    const dsKey  = getKey('deepseek');
    const oaiKey = getKey('openai');
    if (!dsKey && !oaiKey) {
      send(res, 400, { ok: false, error: 'No AI keys configured. POST /ai/keys with { provider, key }.' });
      return true;
    }
    try {
      const msgs: Msg[] = msgs_b ?? [{ role: 'user', content: String(b.prompt ?? '') }];
      const result = dsKey
        ? await deepseekChat(msgs, model_b() || 'deepseek-chat', opts_b)
        : await openaiChat(msgs, model_b() || 'gpt-4o', opts_b);
      const provider = dsKey ? 'deepseek' : 'openai';
      send(res, 200, { ok: true, provider, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
}
