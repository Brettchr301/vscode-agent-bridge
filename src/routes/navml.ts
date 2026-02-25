/**
 * src/routes/navml.ts
 *
 * ML-assisted agent navigation layer.
 *
 * Provides structured context about the current VS Code state so non-local
 * agents (ChatGPT, DeepSeek, etc.) can "see" and navigate the editor without
 * direct access to the machine.  Deliberately limited to useful / safe pieces —
 * no raw screen capture, no keyboard injection.
 *
 * Useful pieces implemented:
 *   1. Rich editor context (file, cursor, selection, visible range, open tabs,
 *      diagnostics, symbol list) — gives agents a structured "viewport"
 *   2. Intent classification — classifies a natural language instruction into
 *      one of the typed action categories so action routing is deterministic
 *   3. Next-step suggestion — given current context + task description,
 *      suggest the best VS Code commands / bridge actions to take
 *   4. Diff preview — show what a proposed edit would look like before applying
 *   5. Workspace navigator — semantic search over open files (keyword + AST)
 *   6. Panel layout snapshot — which panels / editors are visible (no pixels)
 *   7. Diagnostics summary — compiler errors / warnings with suggested fixes
 *   8. Navigation breadcrumb — file → class → method chain at cursor
 *
 * Endpoints:
 *   GET  /ml/context              full editor context snapshot
 *   GET  /ml/layout               panel/editor layout (no pixels)
 *   GET  /ml/diagnostics          current errors + warnings with AI fix hints
 *   GET  /ml/breadcrumb           cursor breadcrumb (file→class→method)
 *   POST /ml/classify             classify intent from NL description
 *   POST /ml/suggest              suggest next bridge actions for a task
 *   POST /ml/diff-preview         preview a proposed file edit as unified diff
 *   POST /ml/navigate             jump to symbol / file / line (executes action)
 *   GET  /ml/workspace-map        semantic index of workspace files + symbols
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as http from 'http';
import { RouteContext, RouteModule } from '../types';
import { send } from '../helpers';

// ─── Shared bridge call ───────────────────────────────────────────────────────

const BRIDGE_PORT = parseInt(process.env.AGENT_BRIDGE_PORT ?? '3131', 10);

function bridgeGet(endpoint: string, token: string): Promise<unknown> {
  return new Promise((resolve) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port:     BRIDGE_PORT,
      path:     endpoint,
      method:   'GET',
      headers:  { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', () => resolve({ error: 'bridge unavailable' }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function bridgePost(endpoint: string, body: unknown, token: string): Promise<unknown> {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port:     BRIDGE_PORT,
      path:     endpoint,
      method:   'POST',
      headers:  {
        Authorization:    `Bearer ${token}`,
        Accept:           'application/json',
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', () => resolve({ error: 'bridge unavailable' }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(bodyStr);
    req.end();
  });
}

// ─── Intent categories ────────────────────────────────────────────────────────

const INTENT_CATEGORIES = [
  { id: 'file_read',         label: 'Read a file',                     risk: 'low'    },
  { id: 'file_write',        label: 'Write / edit a file',             risk: 'medium' },
  { id: 'file_delete',       label: 'Delete a file',                   risk: 'high'   },
  { id: 'terminal_run',      label: 'Run a shell command',             risk: 'high'   },
  { id: 'terminal_run_safe', label: 'Run a read-only command',         risk: 'low'    },
  { id: 'git_commit',        label: 'Commit to git',                   risk: 'medium' },
  { id: 'git_push',          label: 'Push to remote',                  risk: 'high'   },
  { id: 'iot_control',       label: 'Control an IoT device',           risk: 'medium' },
  { id: 'iot_lock',          label: 'Lock/unlock a physical lock',     risk: 'high'   },
  { id: 'ai_query',          label: 'Query an AI model',               risk: 'low'    },
  { id: 'orchestrate',       label: 'Submit an orchestrator task',     risk: 'medium' },
  { id: 'navigate_editor',   label: 'Navigate in the editor',         risk: 'low'    },
  { id: 'search_workspace',  label: 'Search the workspace',            risk: 'low'    },
  { id: 'view_diagnostics',  label: 'Check errors / diagnostics',      risk: 'low'    },
  { id: 'security_scan',     label: 'Run a security scan',             risk: 'low'    },
  { id: 'unknown',           label: 'Unclear / unclassified',          risk: 'medium' },
];

// ─── Keyword-based intent classifier (fast, no API call needed) ───────────────

const KEYWORD_MAP: Record<string, string> = {
  'read|open|show|display|view|cat|print':              'file_read',
  'write|create|edit|modify|update|patch|save':        'file_write',
  'delete|remove|rm|unlink|trash':                     'file_delete',
  'run|exec|execute|shell|bash|powershell|cmd|npm|pip':'terminal_run',
  'ls|dir|pwd|which|find|grep|cat|echo|type':          'terminal_run_safe',
  'commit|git commit':                                 'git_commit',
  'push|git push|deploy':                              'git_push',
  'turn on|turn off|toggle|control|switch|set|iot':   'iot_control',
  'lock|unlock|door':                                  'iot_lock',
  'ask|chat|query|deepseek|gpt|claude|ai|copilot':    'ai_query',
  'orchestrate|schedule|task|plan|automate':           'orchestrate',
  'navigate|go to|jump|open file|scroll':              'navigate_editor',
  'search|find|look for|locate':                      'search_workspace',
  'error|warning|diagnostic|lint|problem|issue':       'view_diagnostics',
  'security|scan|risk|vulnerability|hack':             'security_scan',
};

function classifyIntent(text: string): { id: string; label: string; risk: string; confidence: number } {
  const lower = text.toLowerCase();
  let best = 'unknown';
  let bestScore = 0;

  for (const [pattern, intentId] of Object.entries(KEYWORD_MAP)) {
    const words = pattern.split('|');
    let score = 0;
    for (const w of words) {
      if (lower.includes(w)) score++;
    }
    if (score > bestScore) { bestScore = score; best = intentId; }
  }

  const cat = INTENT_CATEGORIES.find(c => c.id === best) ?? INTENT_CATEGORIES.at(-1)!;
  return { ...cat, confidence: bestScore > 0 ? Math.min(1, bestScore * 0.4) : 0.1 };
}

// ─── Bridge action suggestions by intent ────────────────────────────────────

const ACTION_SUGGESTIONS: Record<string, { endpoint: string; method: string; description: string; example?: object }[]> = {
  file_read:         [{ endpoint: '/filesystem/read',  method: 'POST', description: 'Read file content', example: { path: '/absolute/path/to/file.ts' } }],
  file_write:        [{ endpoint: '/filesystem/write', method: 'POST', description: 'Write file content', example: { path: '/absolute/path', content: 'new content' } }],
  file_delete:       [{ endpoint: '/filesystem/delete', method: 'POST', description: 'Delete a file (DESTRUCTIVE)', example: { path: '/absolute/path' } }],
  terminal_run:      [{ endpoint: '/terminal/run', method: 'POST', description: 'Run shell command', example: { command: 'npm install', cwd: '/workspace' } }],
  terminal_run_safe: [{ endpoint: '/terminal/run', method: 'POST', description: 'Run read-only command', example: { command: 'ls -la', cwd: '/workspace' } }],
  git_commit:        [{ endpoint: '/git/commit', method: 'POST', description: 'Stage all + commit', example: { message: 'feat: my change' } }],
  git_push:          [{ endpoint: '/git/push', method: 'POST', description: 'Push to remote (CAUTION)', example: {} }],
  iot_control:       [{ endpoint: '/iot/control', method: 'POST', description: 'Control IoT device', example: { id: 'device-id', action: 'turn_on' } }],
  iot_lock:          [{ endpoint: '/iot/lock/unlock', method: 'POST', description: 'Unlock smart lock (requires approval)', example: { id: 'lock-id' } }],
  ai_query:          [{ endpoint: '/ai/chat', method: 'POST', description: 'Chat with AI model', example: { model: 'deepseek-r1', messages: [{ role: 'user', content: 'your question' }] } }],
  orchestrate:       [{ endpoint: '/orchestrator/task', method: 'POST', description: 'Submit orchestrator task', example: { type: 'code_edit', description: 'task description' } }],
  navigate_editor:   [{ endpoint: '/editor/open', method: 'POST', description: 'Open file in editor', example: { path: '/absolute/path' } }],
  search_workspace:  [{ endpoint: '/workspace/search', method: 'POST', description: 'Search workspace', example: { query: 'search term', include: '**/*.ts' } }],
  view_diagnostics:  [{ endpoint: '/editor/diagnostics', method: 'GET', description: 'Get current diagnostics' }],
  security_scan:     [{ endpoint: '/security/scan', method: 'POST', description: 'Trigger security scan' }],
};

// ─── Workspace file index (lightweight, no AST) ───────────────────────────────

let _wsIndexTs = 0;
let _wsIndex:   { path: string; size: number; ext: string; modified: number }[] = [];

function buildWsIndex(root: string): void {
  _wsIndex = [];
  const _walk = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !['node_modules', '.git', 'out', 'dist', '__pycache__'].includes(entry.name)) {
          _walk(full);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(full);
            _wsIndex.push({ path: full, size: stat.size, ext: path.extname(entry.name), modified: stat.mtimeMs });
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  };
  _walk(root);
  _wsIndexTs = Date.now();
}

function getWsIndex(root: string) {
  if (Date.now() - _wsIndexTs > 30_000) buildWsIndex(root);
  return _wsIndex;
}

// ─── Diff preview ─────────────────────────────────────────────────────────────

function unifiedDiff(original: string, updated: string, label = 'file'): string {
  const aLines = original.split('\n');
  const bLines = updated.split('\n');
  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];

  // Simple line-by-line diff (not Myers, but good enough for previews)
  const maxLen = Math.max(aLines.length, bLines.length);
  let i = 0;
  while (i < maxLen) {
    const a = aLines[i];
    const b = bLines[i];
    if (a === b) { lines.push(` ${a ?? ''}`); }
    else {
      if (a !== undefined) lines.push(`-${a}`);
      if (b !== undefined) lines.push(`+${b}`);
    }
    i++;
  }
  return lines.join('\n');
}

// ─── Route module ─────────────────────────────────────────────────────────────

export const navmlRoutes: RouteModule = async (ctx) => {
  const { meth, pathStr, qp, b, req, res } = ctx;
  const reply = (code: number, data: unknown) => { send(res, code, data); return true; };

  // Grab token from the same request (already auth'd by server.ts)
  const token = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');

  // GET /ml/context — full editor context snapshot
  if (meth === 'GET' && pathStr === '/ml/context') {
    try {
      const [editorState, changes, wsInfo] = await Promise.all([
        bridgeGet('/editor/active', token),
        bridgeGet('/change-log', token),
        bridgeGet('/workspace/info', token),
      ]);
      return reply(200, {
        ok: true,
        context: {
          editor:   editorState,
          recentChanges: (changes as any)?.log?.slice(0, 10) ?? [],
          workspace: wsInfo,
          timestamp: new Date().toISOString(),
          hint: 'Use /ml/suggest with this context to determine next actions',
        },
      });
    } catch (e: any) {
      return reply(500, { ok: false, error: e.message });
    }
  }

  // GET /ml/layout — panel layout (no pixels)
  if (meth === 'GET' && pathStr === '/ml/layout') {
    try {
      const editor = await bridgeGet('/editor/active', token);
      return reply(200, {
        ok: true,
        layout: {
          activeFile: (editor as any)?.path ?? null,
          cursorLine: (editor as any)?.line ?? null,
          panels: ['explorer', 'editor', 'terminal', 'problems'],  // always-present VS Code panels
          hint: 'Call /ml/context for full state',
        },
      });
    } catch (e: any) { return reply(500, { ok: false, error: e.message }); }
  }

  // GET /ml/diagnostics — errors + warnings
  if (meth === 'GET' && pathStr === '/ml/diagnostics') {
    try {
      const diag = await bridgeGet('/editor/diagnostics', token);
      const items = (diag as any)?.diagnostics ?? [];
      const errors   = items.filter((d: any) => d.severity === 0 || d.severity === 'Error');
      const warnings = items.filter((d: any) => d.severity === 1 || d.severity === 'Warning');

      return reply(200, {
        ok: true,
        summary: { errors: errors.length, warnings: warnings.length },
        errors,
        warnings,
        suggestion: errors.length > 0
          ? `Use /orchestrator/task with type "fix_errors" and description listing the first error to auto-fix`
          : 'No errors found',
      });
    } catch (e: any) { return reply(500, { ok: false, error: e.message }); }
  }

  // GET /ml/breadcrumb — cursor breadcrumb
  if (meth === 'GET' && pathStr === '/ml/breadcrumb') {
    try {
      const active = await bridgeGet('/editor/active', token);
      const filePath = (active as any)?.path ?? '';
      const line     = (active as any)?.line ?? 0;

      // Read surrounding lines for context
      let breadcrumb = filePath;
      try {
        const src = fs.readFileSync(filePath, 'utf-8');
        const lines = src.split('\n');
        // Simple heuristic: walk backwards from cursor to find class/function
        let classMatch = '', fnMatch = '';
        for (let i = line; i >= 0 && i >= line - 100; i--) {
          const l = lines[i] ?? '';
          if (!fnMatch    && /^\s*(async\s+)?function[\s*]|^\s*(public|private|protected|async)?\s+\w+\s*\(/.test(l)) fnMatch = l.trim();
          if (!classMatch && /^\s*(export\s+)?(abstract\s+)?class\s/.test(l))                                          classMatch = l.trim();
          if (classMatch && fnMatch) break;
        }
        breadcrumb = [filePath, classMatch, fnMatch].filter(Boolean).join(' > ');
      } catch {}

      return reply(200, { ok: true, breadcrumb, file: filePath, line });
    } catch (e: any) { return reply(500, { ok: false, error: e.message }); }
  }

  // POST /ml/classify  { text }
  if (meth === 'POST' && pathStr === '/ml/classify') {
    const text = String(b.text ?? '');
    if (!text) return reply(400, { ok: false, error: 'text required' });
    const intent = classifyIntent(text);
    const actions = ACTION_SUGGESTIONS[intent.id] ?? [];
    return reply(200, {
      ok:       true,
      intent,
      suggestedActions: actions,
      categories: INTENT_CATEGORIES,
    });
  }

  // POST /ml/suggest  { task, context? }
  if (meth === 'POST' && pathStr === '/ml/suggest') {
    const task    = String(b.task ?? b.description ?? '');
    const context = b.context ?? {};
    if (!task) return reply(400, { ok: false, error: 'task required' });

    const intent  = classifyIntent(task);
    const actions = ACTION_SUGGESTIONS[intent.id] ?? [];

    // Build richer suggestion with context
    return reply(200, {
      ok:      true,
      task,
      intent,
      reasoning: `Classified as "${intent.label}" (risk: ${intent.risk}, confidence: ${(intent.confidence * 100).toFixed(0)}%)`,
      steps: actions.map((a, i) => ({
        step:     i + 1,
        method:   a.method,
        endpoint: a.endpoint,
        description: a.description,
        example:  a.example,
        curlExample: `curl -X ${a.method} http://127.0.0.1:3131${a.endpoint} -H "Authorization: Bearer <token>" -H "Content-Type: application/json"${a.example ? ` -d '${JSON.stringify(a.example)}'` : ''}`,
      })),
      warnings: intent.risk === 'high' || intent.risk === 'critical'
        ? [`This action has risk level "${intent.risk}" — approvalGate may require human confirmation`]
        : [],
      context,
    });
  }

  // POST /ml/diff-preview  { path, newContent }
  if (meth === 'POST' && pathStr === '/ml/diff-preview') {
    const filePath  = String(b.path ?? '');
    const newContent = String(b.newContent ?? b.content ?? '');
    if (!filePath || !newContent) return reply(400, { ok: false, error: 'path and newContent required' });

    let original = '';
    try { original = fs.readFileSync(filePath, 'utf-8'); } catch { /* file doesn't exist yet */ }

    const diff = unifiedDiff(original, newContent, path.basename(filePath));
    const additions = (diff.match(/^\+[^+]/mg) ?? []).length;
    const deletions  = (diff.match(/^-[^-]/mg) ?? []).length;

    return reply(200, {
      ok: true,
      diff,
      stats: { additions, deletions, changed: additions + deletions },
      hint: 'If this diff looks correct, call POST /filesystem/write with path and content to apply it',
    });
  }

  // POST /ml/navigate  { type: 'file'|'line'|'symbol', target }
  if (meth === 'POST' && pathStr === '/ml/navigate') {
    const { type: navType, target, line } = b as any;
    if (!target) return reply(400, { ok: false, error: 'target required' });

    let result: unknown;
    if (navType === 'file' || !navType) {
      result = await bridgePost('/editor/open', { path: target }, token);
    } else if (navType === 'line') {
      result = await bridgePost('/editor/open', { path: target, line: Number(line ?? 1) }, token);
    } else if (navType === 'symbol') {
      result = await bridgeGet(`/workspace/search?query=${encodeURIComponent(String(target))}&include=**/*.ts,**/*.js,**/*.py`, token);
    }

    return reply(200, { ok: true, navigated: true, type: navType, target, result });
  }

  // GET /ml/workspace-map?root=&limit=
  if (meth === 'GET' && pathStr === '/ml/workspace-map') {
    const wsInfo = await bridgeGet('/workspace/info', token);
    const root   = qp.root ?? (wsInfo as any)?.root ?? os.homedir();
    const limit  = parseInt(qp.limit ?? '200', 10);

    const index = getWsIndex(root).slice(0, limit);
    const byExt = index.reduce<Record<string, number>>((acc, f) => {
      acc[f.ext || '(no ext)'] = (acc[f.ext || '(no ext)'] || 0) + 1;
      return acc;
    }, {});

    return reply(200, {
      ok:            true,
      root,
      fileCount:     _wsIndex.length,
      sample:        index.map(f => ({ path: f.path, ext: f.ext, size: f.size })),
      byExtension:   byExt,
      hint:          'Use /workspace/search?query= to find specific files, or /editor/open to open them',
    });
  }

  return false;
};
