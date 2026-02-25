#!/usr/bin/env node
/**
 * mcp/sse-server.ts
 *
 * HTTP + Server-Sent Events (SSE) transport for the Agent Bridge MCP server.
 *
 * This lets ChatGPT, Cursor (web), and any MCP-over-HTTP client connect
 * without needing stdio.
 *
 * Endpoints:
 *   GET  /sse             — open SSE stream; server sends {sessionId} event first
 *   POST /message         — send a JSON-RPC 2.0 request  ?session=<sessionId>
 *   GET  /mcp/health      — simple health check
 *   GET  /mcp/tools       — return tool list JSON (for debugging / ChatGPT discovery)
 *
 * Run:
 *   node mcp/sse-server.js          (default port 3132)
 *   AGENT_BRIDGE_SSE_PORT=4000 node mcp/sse-server.js
 *
 * ChatGPT Desktop  →  Settings → Connected Apps → MCP Servers
 *   URL: http://127.0.0.1:3132/sse
 *
 * For ChatGPT Web (needs public URL):
 *   npx ngrok http 3132
 *   URL: https://<your-ngrok-subdomain>.ngrok.io/sse
 */

import * as http     from 'http';
import * as https    from 'https';
import { randomUUID } from 'crypto';

const SSE_PORT    = parseInt(process.env.AGENT_BRIDGE_SSE_PORT ?? '3132', 10);
const BRIDGE_PORT = parseInt(process.env.AGENT_BRIDGE_PORT    ?? '3131', 10);
const AUTH_TOKEN  = process.env.AGENT_BRIDGE_TOKEN ?? '';

// ─── SSE session store ────────────────────────────────────────────────────────

interface SseSession {
  id:      string;
  res:     http.ServerResponse;
  created: number;
}

const sessions = new Map<string, SseSession>();

function send(res: SseSession['res'], event: string, data: unknown) {
  const str = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  try { res.write(str); } catch { /* client disconnected */ }
}

function sendSession(s: SseSession, event: string, data: unknown) {
  send(s.res, event, data);
}

// Clean up dead sessions every 5 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 min
  for (const [id, s] of sessions) {
    if (s.created < cutoff) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ─── Bridge HTTP helpers ──────────────────────────────────────────────────────

function bridgeReq(method: string, path: string, body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port:     BRIDGE_PORT,
      path,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const bridgeGet  = (ep: string, qs = '') => bridgeReq('GET',  ep + (qs ? `?${qs}` : ''));
const bridgePost = (ep: string, b: unknown) => bridgeReq('POST', ep, JSON.stringify(b));

// ─── Tool definitions (same as stdio server) ──────────────────────────────────

// We import the full list from a shared tools file. For now, define the core
// subset inline so this file is standalone; the full dispatch below handles all.

const TOOLS = [
  // Bridge
  { name: 'bridge_status',      description: 'Get bridge health and version',                 inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'bridge_log',         description: 'Get recent request log',                        inputSchema: { type: 'object' as const, properties: { limit: { type: 'number', description: 'Max entries' } } } },
  // Editor
  { name: 'editor_read_file',   description: 'Read a file from the workspace',                inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Absolute or workspace-relative path' } }, required: ['path'] as string[] } },
  { name: 'editor_write_file',  description: 'Write content to a workspace file',             inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'New content' } }, required: ['path', 'content'] as string[] } },
  { name: 'editor_diff_file',   description: 'Show unified diff of a file vs last save',     inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] as string[] } },
  // Terminal
  { name: 'terminal_run',       description: 'Run a shell command in VS Code terminal',       inputSchema: { type: 'object' as const, properties: { command: { type: 'string', description: 'Shell command' }, cwd: { type: 'string', description: 'Working directory' } }, required: ['command'] as string[] } },
  // Git
  { name: 'git_status',         description: 'Get git status of the workspace',               inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'git_commit',         description: 'Stage all files and commit',                    inputSchema: { type: 'object' as const, properties: { message: { type: 'string', description: 'Commit message' } }, required: ['message'] as string[] } },
  // AI
  { name: 'ai_chat',            description: 'Chat with DeepSeek or OpenAI (auto-route)',    inputSchema: { type: 'object' as const, properties: { prompt: { type: 'string', description: 'User message' }, model: { type: 'string', description: 'Model name (optional)' } }, required: ['prompt'] as string[] } },
  { name: 'ai_deepseek_r1',    description: 'Ask DeepSeek R1 (reasoning model)',             inputSchema: { type: 'object' as const, properties: { prompt: { type: 'string', description: 'Question or task' } }, required: ['prompt'] as string[] } },
  { name: 'ai_codex_complete',  description: 'Complete code with OpenAI GPT-4o (Codex)',    inputSchema: { type: 'object' as const, properties: { prompt: { type: 'string', description: 'Code + description' }, language: { type: 'string', description: 'Language hint' } }, required: ['prompt'] as string[] } },
  // IoT
  { name: 'iot_list_devices',   description: 'List all registered IoT devices',              inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'iot_control',        description: 'Control an IoT device',                        inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Device ID' }, action: { type: 'string', description: 'Action e.g. turn_on' }, params: { type: 'string', description: 'JSON params' } }, required: ['id', 'action'] as string[] } },
  { name: 'iot_command',        description: 'Send natural language command to IoT devices', inputSchema: { type: 'object' as const, properties: { text: { type: 'string', description: 'e.g. "turn off the living room lights"' } }, required: ['text'] as string[] } },
  { name: 'iot_discover',       description: 'Discover IoT devices on the LAN',              inputSchema: { type: 'object' as const, properties: { subnet: { type: 'string', description: 'IP prefix e.g. 192.168.1' } } } },
  { name: 'roomba_avoid_occupied', description: 'Start Roomba, skip rooms with people in them', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Roomba device ID' } }, required: ['id'] as string[] } },
  // Presence
  { name: 'presence_rooms',     description: 'Get list of currently occupied rooms',         inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'presence_who_is_home', description: 'List all people currently home',             inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'presence_scan',      description: 'Ping all registered phones to refresh presence', inputSchema: { type: 'object' as const, properties: {} } },
  // Automations
  { name: 'automation_list',    description: 'List all automation rules',                    inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'automation_create',  description: 'Create an automation rule',                    inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Rule name' }, trigger: { type: 'string', description: 'time | cron | presence' }, time: { type: 'string', description: 'HH:MM for time trigger' }, cron: { type: 'string', description: '5-field cron expression' }, presence_event: { type: 'string', description: 'Presence event string' }, actions: { type: 'string', description: 'JSON array of action objects' } }, required: ['name', 'trigger', 'actions'] as string[] } },
  { name: 'automation_run',     description: 'Manually trigger an automation rule',          inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Rule ID' } }, required: ['id'] as string[] } },
  // Slack
  { name: 'slack_post',         description: 'Post a message to Slack',                      inputSchema: { type: 'object' as const, properties: { channel: { type: 'string', description: 'Channel ID' }, text: { type: 'string', description: 'Message text' } }, required: ['text'] as string[] } },
];

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'bridge_status':      return bridgeGet('/health');
    case 'bridge_log':         return bridgeGet('/log', args.limit ? `limit=${args.limit}` : '');
    case 'editor_read_file':   return bridgeGet('/fs/read', `path=${encodeURIComponent(String(args.path))}`);
    case 'editor_write_file':  return bridgePost('/fs/write', { path: args.path, content: args.content });
    case 'editor_diff_file':   return bridgeGet('/fs/diff', `path=${encodeURIComponent(String(args.path))}`);
    case 'terminal_run':       return bridgePost('/terminal/run', { command: args.command, cwd: args.cwd });
    case 'git_status':         return bridgeGet('/git/status');
    case 'git_commit':         return bridgePost('/git/commit', { message: args.message });
    case 'ai_chat':            return bridgePost('/ai/chat', { prompt: args.prompt, model: args.model });
    case 'ai_deepseek_r1':     return bridgePost('/ai/deepseek/r1', { prompt: args.prompt });
    case 'ai_codex_complete':  return bridgePost('/ai/codex/complete', { prompt: args.prompt });
    case 'iot_list_devices':   return bridgeGet('/iot/devices');
    case 'iot_control': {
      const p = args.params ? JSON.parse(String(args.params)) : {};
      return bridgePost('/iot/control', { id: args.id, action: args.action, params: p });
    }
    case 'iot_command':        return bridgePost('/iot/command', { text: args.text });
    case 'iot_discover':       return bridgePost('/iot/discover', { subnet: args.subnet });
    case 'roomba_avoid_occupied': return bridgePost('/iot/roomba/avoid-occupied', { id: args.id });
    case 'presence_rooms':     return bridgeGet('/presence/rooms');
    case 'presence_who_is_home': return bridgeGet('/presence/who-is-home');
    case 'presence_scan':      return bridgePost('/presence/scan', {});
    case 'automation_list':    return bridgeGet('/automations');
    case 'automation_create': {
      const actions = typeof args.actions === 'string' ? JSON.parse(String(args.actions)) : args.actions;
      return bridgePost('/automations', { ...args, actions });
    }
    case 'automation_run':     return bridgePost(`/automations/${args.id}/run`, {});
    case 'slack_post':         return bridgePost('/slack-post', { channel: args.channel, text: args.text });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC handler ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id:      string | number | null;
  method:  string;
  params?: unknown;
}

async function handleJsonRpc(rpc: JsonRpcRequest): Promise<unknown> {
  const { id, method, params } = rpc;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'vscode-agent-bridge', version: '3.5.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0', id,
      result: { tools: TOOLS },
    };
  }

  if (method === 'tools/call') {
    const p = params as { name: string; arguments?: Record<string, unknown> };
    try {
      const result = await dispatchTool(p.name, p.arguments ?? {});
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }],
        },
      };
    } catch (e) {
      return {
        jsonrpc: '2.0', id,
        error: { code: -32603, message: String(e) },
      };
    }
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  return {
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const rawUrl  = req.url ?? '/';
  const urlPath = rawUrl.split('?')[0];
  const qp      = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1] : '');

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /sse ────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/sse') {
    const sessionId = randomUUID();
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: disable buffering
    });

    // MCP SSE protocol: first event must be `endpoint`
    const postUrl = `http://127.0.0.1:${SSE_PORT}/message?session=${sessionId}`;
    res.write(`event: endpoint\ndata: ${JSON.stringify(postUrl)}\n\n`);

    const session: SseSession = { id: sessionId, res, created: Date.now() };
    sessions.set(sessionId, session);

    req.on('close', () => {
      sessions.delete(sessionId);
    });

    // Keepalive ping every 15 s
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { clearInterval(ping); sessions.delete(sessionId); }
    }, 15_000);

    req.on('close', () => clearInterval(ping));
    return;
  }

  // ── POST /message ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/message') {
    const sessionId = qp.get('session');
    const session   = sessionId ? sessions.get(sessionId) : undefined;

    // Collect body
    let raw = '';
    for await (const chunk of req) raw += chunk;

    // 202 Accepted immediately
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    let rpc: JsonRpcRequest;
    try { rpc = JSON.parse(raw); }
    catch { return; }

    const result = await handleJsonRpc(rpc);

    if (session) {
      sendSession(session, 'message', result);
    }
    return;
  }

  // ── GET /mcp/health ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/mcp/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok:           true,
      server:       'vscode-agent-bridge-sse',
      version:      '3.5.0',
      sse_port:     SSE_PORT,
      bridge_port:  BRIDGE_PORT,
      active_sessions: sessions.size,
      connect_url:  `http://127.0.0.1:${SSE_PORT}/sse`,
    }));
    return;
  }

  // ── GET /mcp/tools ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/mcp/tools') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tools: TOOLS, count: TOOLS.length }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: urlPath }));
});

server.listen(SSE_PORT, '0.0.0.0', () => {
  console.error(
    `[agent-bridge MCP SSE server] listening on port ${SSE_PORT}\n` +
    `  ChatGPT Desktop URL : http://127.0.0.1:${SSE_PORT}/sse\n` +
    `  Health check        : http://127.0.0.1:${SSE_PORT}/mcp/health\n` +
    `  Public (ngrok)      : ngrok http ${SSE_PORT}  →  https://<sub>.ngrok.io/sse`,
  );
});
