/**
 * VS Code Agent Bridge  v3.7   entry point
 *
 * Starts an HTTP bridge on :3131, an MCP SSE server on :3132 (for ChatGPT),
 * an automation/scheduling engine, and a security monitoring layer.
 *
 * GitHub: https://github.com/Brettchr301/vscode-agent-bridge
 */
import * as vscode from 'vscode';
import * as http   from 'http';
import * as cp     from 'child_process';
import * as path   from 'path';
import * as fs     from 'fs';
import { createHttpServer, registerChangeListeners, getToken, seedServices } from './server';
import { activePort } from './state';
import { startAutomationEngine, stopAutomationEngine, injectPresenceFns } from './routes/automations';
import { getOccupiedRooms, isAnyoneHome } from './routes/presence';
import { runSecurityScan } from './routes/security';
import { setNotifyFn } from './services/approval';

let srv:    http.Server | null        = null;
let sseProc: cp.ChildProcess | null   = null;
let bar:     vscode.StatusBarItem;
let tokenBar: vscode.StatusBarItem;
let secBar:   vscode.StatusBarItem;
let secPanel: vscode.WebviewPanel | null = null;

export function activate(context: vscode.ExtensionContext) {

  // ── Main status bar button ─────────────────────────────────────────────────
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  bar.text    = '$(plug) Agent Bridge';
  bar.tooltip = 'Agent Bridge — click to copy endpoint URL';
  bar.command = 'agentBridge.copyUrl';
  bar.show();
  context.subscriptions.push(bar);

  // ── Token status bar item (click to copy) ────────────────────────────────
  tokenBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
  tokenBar.text    = '$(key) AB Token';
  tokenBar.tooltip = 'Agent Bridge Auth Token — click to copy';
  tokenBar.command = 'agentBridge.copyToken';
  tokenBar.show();
  context.subscriptions.push(tokenBar);

  // ── Security status bar (🛡 shields show risk level) ───────────────────────
  secBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 998);
  secBar.text    = '$(shield) Security';
  secBar.tooltip = 'Agent Bridge Security Dashboard — click to open';
  secBar.command = 'agentBridge.securityDashboard';
  secBar.show();
  context.subscriptions.push(secBar);

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.copyUrl', async () => {
      const url = `http://127.0.0.1:${activePort}`;
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`Agent Bridge URL copied: ${url}`);
    }),
    vscode.commands.registerCommand('agentBridge.showLog', () => {
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${activePort}/log`));
    }),
    vscode.commands.registerCommand('agentBridge.copyToken', async () => {
      const token = getToken();
      await vscode.env.clipboard.writeText(token);
      vscode.window.showInformationMessage(
        `Agent Bridge token copied! Use as: Authorization: Bearer ${token.slice(0, 8)}…`,
      );
    }),
    vscode.commands.registerCommand('agentBridge.showToken', () => {
      const token = getToken();
      vscode.window.showInformationMessage(
        `Agent Bridge Auth Token:\n${token}`,
        'Copy',
      ).then(sel => {
        if (sel === 'Copy') vscode.env.clipboard.writeText(token);
      });
    }),

    vscode.commands.registerCommand('agentBridge.securityDashboard', () => {
      // Reuse existing panel if open
      if (secPanel) { secPanel.reveal(vscode.ViewColumn.One); return; }

      secPanel = vscode.window.createWebviewPanel(
        'agentBridgeSecurity',
        '🛡 Security Dashboard',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
          retainContextWhenHidden: true,
        },
      );

      const htmlFile = path.join(context.extensionPath, 'media', 'security-dashboard.html');
      let html = fs.readFileSync(htmlFile, 'utf-8');
      const port  = activePort;
      const token = getToken();
      // Inject bridge URL and token so the webview can call the API
      html = html
        .replace(`window.__BRIDGE_URL__ || 'http://127.0.0.1:3131'`,
                 `'http://127.0.0.1:${port}'`)
        .replace(`window.__AUTH_TOKEN__  || ''`,
                 `'${token}'`);
      secPanel.webview.html = html;

      // Update shield badge with live risk score every 60 s
      const updateShield = () => {
        try {
          const profiles = runSecurityScan();
          const overall  = profiles.length
            ? Math.round(profiles.reduce((s, p) => s + p.riskScore, 0) / profiles.length)
            : 0;
          const icon = overall >= 75 ? '$(error)'
                     : overall >= 50 ? '$(warning)'
                     : overall >= 25 ? '$(shield)'
                     : '$(pass)';
          secBar.text    = `${icon} Sec: ${overall}`;
          secBar.tooltip = `Security score: ${overall}/100 — click to open dashboard`;
        } catch { /* ignored */ }
      };
      updateShield();
      const shieldTimer = setInterval(updateShield, 60_000);

      secPanel.onDidDispose(() => {
        secPanel = null;
        clearInterval(shieldTimer);
        secBar.text    = '$(shield) Security';
        secBar.tooltip = 'Agent Bridge Security Dashboard — click to open';
      }, null, context.subscriptions);
    }),
  );

  // ── File change tracking ──────────────────────────────────────────────────
  registerChangeListeners(context);

  // ── Start HTTP bridge ─────────────────────────────────────────────────────
  srv = createHttpServer();

  // ── Show token once the server is up ─────────────────────────────────────
  srv.on('listening', () => {
    const token = getToken();
    const port  = activePort;

    bar.text    = `$(plug) Bridge :${port}`;
    bar.tooltip = `Agent Bridge running on http://127.0.0.1:${port}`;

    const short = token.slice(0, 8);
    tokenBar.text    = `$(key) ${short}…`;
    tokenBar.tooltip = `Agent Bridge token (click to copy): ${token}`;

    // First-run notification
    const configFile = `~/.agent-bridge/config.json`;
    vscode.window.showInformationMessage(
      `Agent Bridge v3.7 started on :${port} | Auth token: ${short}…`,
      'Copy Token',
      'Copy URL',
    ).then(sel => {
      if (sel === 'Copy Token') vscode.env.clipboard.writeText(token);
      if (sel === 'Copy URL')   vscode.env.clipboard.writeText(`http://127.0.0.1:${port}`);
    });
  });

  // ── Seed secret manager + orchestrator with bridge token ────────────────
  //    Done after createHttpServer() ensures token is generated.
  setTimeout(() => {
    seedServices();
    const port  = activePort;
    const token = getToken();
    bar.text    = `$(plug) Bridge :${port}`;
    tokenBar.text = `$(key) ${token.slice(0, 8)}…`;
  }, 500);

  // ── Wire approval gate notification ──────────────────────────────────────
  setNotifyFn((msg, ...items) =>
    Promise.resolve(vscode.window.showWarningMessage(msg, ...items)),
  );

  // ── Inject presence helpers into automation engine ─────────────────────────
  injectPresenceFns(getOccupiedRooms, isAnyoneHome);

  // ── Start automation engine ───────────────────────────────────────────────
  startAutomationEngine();

  // ── Start MCP SSE server (for ChatGPT) ───────────────────────────────────
  const sseScript = path.join(context.extensionPath, 'mcp', 'sse-server.js');
  try {
    const env = {
      ...process.env,
      AGENT_BRIDGE_PORT: String(activePort),
      AGENT_BRIDGE_TOKEN: getToken(),
    };
    sseProc = cp.spawn('node', [sseScript], {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    });
    sseProc.stderr?.on('data', (d: Buffer) => {
      // Surface SSE URL in console
      const msg = d.toString().trim();
      if (msg.includes('listening')) {
        console.log('[agent-bridge SSE]', msg);
      }
    });
    sseProc.on('error', () => {}); // ignore if node not found on PATH
  } catch { /* SSE server is optional */ }

  context.subscriptions.push({
    dispose: () => {
      srv?.close();
      sseProc?.kill();
      stopAutomationEngine();
    },
  });
}

export function deactivate() {
  srv?.close();
  sseProc?.kill();
  stopAutomationEngine();
  bar?.dispose();
  tokenBar?.dispose();
  secBar?.dispose();
  secPanel?.dispose();
}

