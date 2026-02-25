import * as http  from 'http';
import * as vscode from 'vscode';
import * as np from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { send, qs, body, stripBom } from './helpers';
import { chlog, PORT_START, setActivePort, activePort } from './state';
import { bridgeRoutes }    from './routes/bridge';
import { filesystemRoutes } from './routes/filesystem';
import { gitRoutes }        from './routes/git';
import { terminalRoutes }   from './routes/terminal';
import { editorRoutes }     from './routes/editor';
import { workspaceRoutes }  from './routes/workspace';
import { systemRoutes }     from './routes/system';
import { slackRoutes }      from './routes/slack';
import { copilotRoutes }    from './routes/copilot-routes';
import { iotRoutes }        from './routes/iot';
import { presenceRoutes }   from './routes/presence';

/** All route modules in priority order. */
const ROUTE_MODULES = [
  bridgeRoutes,
  copilotRoutes,
  filesystemRoutes,
  gitRoutes,
  terminalRoutes,
  editorRoutes,
  workspaceRoutes,
  systemRoutes,
  slackRoutes,
  iotRoutes,
  presenceRoutes,
];

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const raw     = req.url ?? '/';
  const pathStr = raw.split('?')[0];
  const qp      = qs(raw);
  const meth    = req.method ?? 'GET';

  if (meth === 'OPTIONS') { send(res, 200, {}); return; }

  // Optional auth token check
  const authToken = (() => {
    let t = vscode.workspace.getConfiguration('agentBridge').get<string>('authToken', '');
    if (!t) {
      try {
        const raw2 = stripBom(fs.readFileSync(np.join(os.homedir(), '.agent-bridge', 'config.json'), 'utf-8'));
        t = JSON.parse(raw2).auth_token ?? '';
      } catch {}
    }
    return t;
  })();

  if (authToken && pathStr !== '/health') {
    const supplied = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
    if (supplied !== authToken) {
      send(res, 401, { ok: false, error: 'Unauthorized: missing or invalid Authorization: Bearer <token>' });
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
