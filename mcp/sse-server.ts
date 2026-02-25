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
  // Security
  { name: 'security_score',     description: 'Get overall + per-device risk scores',         inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'security_events',    description: 'Get recent security events (auth failures, brute force, anomalies)', inputSchema: { type: 'object' as const, properties: { limit: { type: 'number', description: 'Max events to return (default 50)' } } } },
  { name: 'security_scan',      description: 'Trigger a full security scan of all IoT devices', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'security_analyze',   description: 'Ask AI (DeepSeek/GPT-4o) to analyse the current security posture and recommend fixes', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'security_remediate', description: 'Get remediation steps for a specific device',  inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Device ID' } }, required: ['id'] as string[] } },
  { name: 'security_rate_limits', description: 'List currently blocked or throttled IP addresses', inputSchema: { type: 'object' as const, properties: {} } },
  // IoT Extended — new protocols
  { name: 'iot_protocols',          description: 'List all 35+ supported IoT protocols and device families', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'iot_zigbee_devices',     description: 'List Zigbee devices via Zigbee2MQTT', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Z2M bridge device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_zigbee_set',         description: 'Set Zigbee device state (on/off/brightness/color)', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Z2M bridge ID' }, ieee: { type: 'string', description: 'IEEE address' }, state: { type: 'string', description: 'JSON state object' } }, required: ['id', 'ieee', 'state'] as string[] } },
  { name: 'iot_zwave_nodes',        description: 'List Z-Wave nodes via Z-Wave JS UI', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Z-Wave device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_modbus_read',        description: 'Read Modbus TCP holding registers', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Modbus device ID' }, register: { type: 'number', description: 'Start register' }, count: { type: 'number', description: 'Number of registers' } }, required: ['id', 'register'] as string[] } },
  { name: 'iot_modbus_write',       description: 'Write a Modbus TCP holding register', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Device ID' }, register: { type: 'number' }, value: { type: 'number' } }, required: ['id', 'register', 'value'] as string[] } },
  { name: 'iot_onvif_info',         description: 'Get ONVIF camera device information', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Camera device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_onvif_snapshot',     description: 'Get snapshot URL from ONVIF camera', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Camera device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_kasa_devices',       description: 'Get TP-Link Kasa device info (local TCP)', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Kasa device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_kasa_set',           description: 'Turn TP-Link Kasa plug on or off', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Device ID' }, state: { type: 'boolean', description: 'true=on, false=off' }, childId: { type: 'string', description: 'For multi-outlet plugs' } }, required: ['id', 'state'] as string[] } },
  { name: 'iot_lock_status',        description: 'Get smart lock status (August/Yale)', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Lock device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_lock_lock',          description: 'Lock a smart lock', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Lock device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_lock_unlock',        description: 'Unlock a smart lock (requires approval if gate enabled)', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Lock device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_powerwall_status',   description: 'Get Tesla Powerwall battery + grid status', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Powerwall device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_enphase_status',     description: 'Get Enphase IQ Gateway solar production stats', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Enphase device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_victron_status',     description: 'Get Victron Energy (MPPT/inverter) status via Modbus', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Victron device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_obd2_status',        description: 'Get live OBD-II vehicle data (RPM, speed, fuel, etc.)', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'OBD-II dongle device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_nest_status',        description: 'Get Google Nest thermostat state', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Nest device ID' } }, required: ['id'] as string[] } },
  { name: 'iot_ecobee_status',      description: 'Get Ecobee thermostat state', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Ecobee device ID' } }, required: ['id'] as string[] } },
  // Orchestrator
  { name: 'orch_status',            description: 'Get orchestrator status, active models, task queue', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'orch_task',              description: 'Submit a task to the multi-model orchestrator (planner→judge→executor→verifier)', inputSchema: { type: 'object' as const, properties: { type: { type: 'string', description: 'code_edit | terminal | git | iot | general | fix_errors' }, description: { type: 'string', description: 'What to do' }, autonomy: { type: 'string', description: 'supervised | assisted | autonomous' } }, required: ['type', 'description'] as string[] } },
  { name: 'orch_task_status',       description: 'Get orchestrator task status and result', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Task ID' } }, required: ['id'] as string[] } },
  { name: 'orch_propose',           description: 'Run parallel proposals (DeepSeek + Copilot) and judge picks best', inputSchema: { type: 'object' as const, properties: { description: { type: 'string', description: 'What you want to build / change' }, type: { type: 'string', description: 'Task type hint' } }, required: ['description'] as string[] } },
  { name: 'orch_models',            description: 'List model profiles with cost, role, and empirical success rates', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'orch_route',             description: 'Ask router which model to use for a task type (cost-optimal)', inputSchema: { type: 'object' as const, properties: { type: { type: 'string', description: 'Task type e.g. code_edit' } }, required: ['type'] as string[] } },
  { name: 'orch_telemetry',         description: 'Get per-model success rate, latency, and cost statistics', inputSchema: { type: 'object' as const, properties: {} } },
  // Approval gate
  { name: 'approval_pending',       description: 'List pending human-approval requests', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'approval_decide',        description: 'Approve or reject a pending action', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Approval request ID' }, decision: { type: 'string', description: 'approved | rejected' }, reason: { type: 'string', description: 'Optional reason' } }, required: ['id', 'decision'] as string[] } },
  // NavML
  { name: 'ml_context',             description: 'Get structured VS Code editor context (active file, cursor, recent changes)', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'ml_diagnostics',         description: 'Get current compiler errors and warnings with fix suggestions', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'ml_classify',            description: 'Classify a natural language instruction into an action category with risk level', inputSchema: { type: 'object' as const, properties: { text: { type: 'string', description: 'What you want to do' } }, required: ['text'] as string[] } },
  { name: 'ml_suggest',             description: 'Get step-by-step bridge API actions to accomplish a task', inputSchema: { type: 'object' as const, properties: { task: { type: 'string', description: 'Describe what you want to accomplish' } }, required: ['task'] as string[] } },
  { name: 'ml_diff_preview',        description: 'Preview a proposed file edit as a unified diff before applying', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Absolute file path' }, newContent: { type: 'string', description: 'Proposed new content' } }, required: ['path', 'newContent'] as string[] } },
  { name: 'ml_workspace_map',       description: 'Get a semantic map of workspace files (paths, extensions, counts)', inputSchema: { type: 'object' as const, properties: {} } },
  // Telemetry
  { name: 'telemetry_summary',      description: 'Get per-model performance summary (success rate, latency, cost)', inputSchema: { type: 'object' as const, properties: {} } },
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
    // Security
    case 'security_score':     return bridgeGet('/security/score');
    case 'security_events':    return bridgeGet('/security/events', args.limit ? `limit=${args.limit}` : 'limit=50');
    case 'security_scan':      return bridgePost('/security/scan', {});
    case 'security_analyze':   return bridgePost('/security/analyze', {});
    case 'security_remediate': return bridgePost(`/security/remediate/${args.id}`, {});
    case 'security_rate_limits': return bridgeGet('/security/rate-limits');
    // IoT Extended
    case 'iot_protocols':         return bridgeGet('/iot/protocols');
    case 'iot_zigbee_devices':    return bridgeGet('/iot/zigbee/devices', `id=${args.id}`);
    case 'iot_zigbee_set':        return bridgePost('/iot/zigbee/set', { id: args.id, ieee: args.ieee, state: typeof args.state === 'string' ? JSON.parse(args.state as string) : args.state });
    case 'iot_zwave_nodes':       return bridgeGet('/iot/zwave/nodes', `id=${args.id}`);
    case 'iot_modbus_read':       return bridgeGet('/iot/modbus/read', `id=${args.id}&register=${args.register}&count=${args.count ?? 1}`);
    case 'iot_modbus_write':      return bridgePost('/iot/modbus/write', { id: args.id, register: args.register, value: args.value });
    case 'iot_onvif_info':        return bridgeGet('/iot/onvif/info', `id=${args.id}`);
    case 'iot_onvif_snapshot':    return bridgeGet('/iot/onvif/snapshot', `id=${args.id}`);
    case 'iot_kasa_devices':      return bridgeGet('/iot/kasa/devices', `id=${args.id}`);
    case 'iot_kasa_set':          return bridgePost('/iot/kasa/set', { id: args.id, state: args.state, childId: args.childId });
    case 'iot_lock_status':       return bridgeGet('/iot/lock/status', `id=${args.id}`);
    case 'iot_lock_lock':         return bridgePost('/iot/lock/lock', { id: args.id });
    case 'iot_lock_unlock':       return bridgePost('/iot/lock/unlock', { id: args.id });
    case 'iot_powerwall_status':  return bridgeGet('/iot/powerwall/status', `id=${args.id}`);
    case 'iot_enphase_status':    return bridgeGet('/iot/enphase/status', `id=${args.id}`);
    case 'iot_victron_status':    return bridgeGet('/iot/victron/status', `id=${args.id}`);
    case 'iot_obd2_status':       return bridgeGet('/iot/obd2/status', `id=${args.id}`);
    case 'iot_nest_status':       return bridgeGet('/iot/nest/status', `id=${args.id}`);
    case 'iot_ecobee_status':     return bridgeGet('/iot/ecobee/status', `id=${args.id}`);
    // Orchestrator
    case 'orch_status':           return bridgeGet('/orchestrator/status');
    case 'orch_task':             return bridgePost('/orchestrator/task', { type: args.type, description: args.description, autonomy: args.autonomy });
    case 'orch_task_status':      return bridgeGet(`/orchestrator/task/${args.id}`);
    case 'orch_propose':          return bridgePost('/orchestrator/propose', { description: args.description, type: args.type });
    case 'orch_models':           return bridgeGet('/orchestrator/models');
    case 'orch_route':            return bridgePost('/orchestrator/route', { type: args.type });
    case 'orch_telemetry':        return bridgeGet('/orchestrator/telemetry');
    // Approval
    case 'approval_pending':      return bridgeGet('/approval/pending');
    case 'approval_decide':       return bridgePost('/approval/decide', { id: args.id, decision: args.decision, reason: args.reason });
    // NavML
    case 'ml_context':            return bridgeGet('/ml/context');
    case 'ml_diagnostics':        return bridgeGet('/ml/diagnostics');
    case 'ml_classify':           return bridgePost('/ml/classify', { text: args.text });
    case 'ml_suggest':            return bridgePost('/ml/suggest', { task: args.task });
    case 'ml_diff_preview':       return bridgePost('/ml/diff-preview', { path: args.path, newContent: args.newContent });
    case 'ml_workspace_map':      return bridgeGet('/ml/workspace-map');
    // Telemetry
    case 'telemetry_summary':     return bridgeGet('/telemetry/summary');
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
        serverInfo:      { name: 'vscode-agent-bridge', version: '3.7.0' },
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
      version:      '3.7.0',
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
