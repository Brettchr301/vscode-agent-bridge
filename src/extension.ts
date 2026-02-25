/**
 * VS Code Agent Bridge  v3.4   entry point
 *
 * Starts an HTTP bridge on :3131 and an MCP-compatible tool registry
 * so any AI agent (Claude Desktop, Cursor, DeepSeek, n8n, Python )
 * can control VS Code, Copilot, the filesystem, git, terminal, and more.
 *
 * GitHub: https://github.com/Brettchr301/vscode-agent-bridge
 */
import * as vscode from 'vscode';
import * as http   from 'http';
import { createHttpServer, registerChangeListeners } from './server';
import { activePort } from './state';

let srv:  http.Server | null       = null;
let bar:  vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {

  // Status bar button
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  bar.text    = '$(plug) Agent Bridge';
  bar.tooltip = 'VS Code Agent Bridge  click to copy endpoint URL';
  bar.command = 'agentBridge.copyUrl';
  bar.show();
  context.subscriptions.push(bar);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.copyUrl', async () => {
      const url = `http://127.0.0.1:${activePort}`;
      await vscode.env.clipboard.writeText(url);
      vscode.window.showInformationMessage(`Agent Bridge URL copied: ${url}`);
    }),
    vscode.commands.registerCommand('agentBridge.showLog', () => {
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${activePort}/log`));
    }),
  );

  // File change tracking
  registerChangeListeners(context);

  // Start HTTP server
  srv = createHttpServer();

  // Update status bar once the port is known
  const updateBar = () => {
    bar.text    = `$(plug) Bridge :${activePort}`;
    bar.tooltip = `Agent Bridge running on http://127.0.0.1:${activePort}`;
  };
  srv.on('listening', updateBar);
  setTimeout(updateBar, 200);

  context.subscriptions.push({ dispose: () => srv?.close() });
}

export function deactivate() {
  srv?.close();
  bar?.dispose();
}
