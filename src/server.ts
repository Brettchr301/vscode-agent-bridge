import * as http  from 'http';
import * as vscode from 'vscode';
import * as np from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { send, qs, body } from './helpers';
import { chlog, PORT_START, setActivePort, activePort } from './state';
import { bridgeRoutes }      from './routes/bridge';
import { filesystemRoutes }  from './routes/filesystem';
import { gitRoutes }         from './routes/git';
import { terminalRoutes }    from './routes/terminal';
import { editorRoutes }      from './routes/editor';
import { workspaceRoutes }   from './routes/workspace';
import { systemRoutes }      from './routes/system';
import { slackRoutes }       from './routes/slack';
import { copilotRoutes }     from './routes/copilot-routes';
import { iotRoutes }         from './routes/iot';
import { iotExtraRoutes }    from './routes/iot-extra';
import { presenceRoutes }    from './routes/presence';
import { automationsRoutes } from './routes/automations';
import { deepseekRoutes }    from './routes/deepseek';
import { securityRoutes, checkRateLimit, recordAuthFailure } from './routes/security';
import { orchestratorRoutes, seedBridgeToken } from './routes/orchestrator';
import { navmlRoutes }       from './routes/navml';
import { approvalRoutes }    from './services/approval';
import { telemetryRoutes }   from './services/telemetry';
import { secretManager }     from './services/secret-manager';

/** All route modules in priority order. */
const ROUTE_MODULES = [
  bridgeRoutes,
  copilotRoutes,
  deepseekRoutes,
  filesystemRoutes,
  gitRoutes,
  terminalRoutes,
  editorRoutes,
  workspaceRoutes,
  systemRoutes,
  slackRoutes,
  iotRoutes,
  iotExtraRoutes,
  presenceRoutes,
  automationsRoutes,
  securityRoutes,
  orchestratorRoutes,
  navmlRoutes,
  approvalRoutes,
  telemetryRoutes,
];

// ─── Auth token (auto-generated on first run, stored in config.json) ─────────

const CONFIG_DIR  = np.join(os.homedir(), '.agent-bridge');
const CONFIG_FILE = np.join(CONFIG_DIR, 'config.json');

let _cachedToken: string | null = null;

export function getOrCreateAuthToken(): string {
  if (_cachedToken) return _cachedToken;

  // 1. VS Code setting (highest priority — lets users override)
  const vsCfg = vscode.workspace.getConfiguration('agentBridge').get<string>('authToken', '').trim();
  if (vsCfg) { _cachedToken = vsCfg; return vsCfg; }

  // 2. Config file
  try {
    const raw  = fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    if (json.auth_token) { _cachedToken = json.auth_token; return json.auth_token; }
  } catch { /* first run */ }

  // 3. Auto-generate
  const token = crypto.randomUUID();
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {}
    existing.auth_token = token;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  } catch (e) {
    console.error('[agent-bridge] could not write config.json:', e);
  }
  _cachedToken = token;
  return token;
}

/** Expose so extension.ts can show the token in a notification on first run. */
export function getToken() { return _cachedToken ?? getOrCreateAuthToken(); }

/**
 * Seed all services that need the auth token.
 * Called once after the token is established at extension activation.
 */
export function seedServices(): void {
  const tok = getToken();
  secretManager.seed('bridge-token', tok);
  seedBridgeToken(tok);
}

// ─────────────────────────────────────────────────────────────────────────────

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const raw     = req.url ?? '/';
  const pathStr = raw.split('?')[0];
  const qp      = qs(raw);
  const meth    = req.method ?? 'GET';

  if (meth === 'OPTIONS') { send(res, 200, {}); return; }

  // ── Rate limiting (blocks brute-force before auth check hits) ─────────────
  const ip = (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '');
  if (!checkRateLimit(ip)) {
    send(res, 429, {
      ok:    false,
      error: 'Too Many Requests',
      hint:  'Rate limit or brute-force block active. Try again later.',
    });
    return;
  }

  // ── Auth enforcement (default ON — auto-generates token on first start) ────
  const authToken = getOrCreateAuthToken();
  const PUBLIC_PATHS = new Set(['/health', '/mcp/health']);
  if (!PUBLIC_PATHS.has(pathStr)) {
    const supplied = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
    if (supplied !== authToken) {
      recordAuthFailure(ip);
      send(res, 401, {
        ok:    false,
        error: 'Unauthorized',
        hint:  'Include header: Authorization: Bearer <token>  (see ~/.agent-bridge/config.json)',
      });
      return;
    }
  }

  const b = await body(req);
  const ctx = { meth, pathStr, qp, b, req, res };

  for (const mod of ROUTE_MODULES) {
    if (await mod(ctx)) return;
  }

  send(res, 404, { ok: false, error: `Unknown: ${meth} ${pathStr}` });
}

/** Start HTTP server. Tries PORT_START, increments on EADDRINUSE. */
export function createHttpServer(): http.Server {
  const server = http.createServer(route);

  const tryListen = (p: number) => {
    server.listen(p, '127.0.0.1', () => {
      setActivePort(p);
    });
  };

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') tryListen(activePort + 1);
  });

  tryListen(PORT_START);
  return server;
}

/** Register VS Code file-change listeners. */
export function registerChangeListeners(context: vscode.ExtensionContext) {
  const push = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return;
    chlog.push({ path: uri.fsPath, ts: Date.now() });
    if (chlog.length > 500) chlog.shift();
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(d => push(d.uri)),
    vscode.workspace.onDidChangeTextDocument(e => push(e.document.uri)),
    vscode.workspace.onDidCreateFiles(e => e.files.forEach(push)),
    vscode.workspace.onDidDeleteFiles(e => e.files.forEach(push)),
    vscode.workspace.onDidRenameFiles(e => e.files.forEach(f => { push(f.oldUri); push(f.newUri); })),
  );
}
