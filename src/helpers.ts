import * as http from 'http';
import * as fs   from 'fs';
import * as np   from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ShellResult } from './types';
import { logEntries, LOG_DIR } from './state';

let logPanel: vscode.WebviewPanel | null = null;
export const setLogPanel = (p: vscode.WebviewPanel | null) => { logPanel = p; };

/** Send a JSON response. */
export const send = (res: http.ServerResponse, status: number, data: unknown) => {
  const j = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  });
  res.end(j);
};

/** Parse query string from URL. */
export const qs = (url: string): Record<string, string> => {
  const i = url.indexOf('?');
  return i < 0 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
};

/** Parse JSON body from request. */
export const body = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise(ok => {
    let s = '';
    req.on('data', c => s += c);
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
    req.on('error', () => ok({}));
  });

/** Write a log entry (memory + file + webview). */
export const log = (method: string, path: string, req: unknown, resp: unknown) => {
  const line = `[${new Date().toISOString()}] ${method} ${path}  req=${JSON.stringify(req).slice(0, 200)}  resp=${JSON.stringify(resp).slice(0, 200)}`;
  logEntries.push(line);
  if (logEntries.length > 200) logEntries.shift();
  if (logPanel) logPanel.webview.postMessage({ type: 'log', line });
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(np.join(LOG_DIR, 'requests.log'), line + '\n');
  } catch {}
};

/** Read file via VS Code document API, fall back to fs. */
export const readText = async (p: string): Promise<string> => {
  try { return (await vscode.workspace.openTextDocument(vscode.Uri.file(p))).getText(); }
  catch { return fs.readFileSync(p, 'utf-8'); }
};

/** Ensure parent directory exists. */
export const mkdirFor = (p: string) => {
  try { fs.mkdirSync(np.dirname(p), { recursive: true }); } catch {}
};

/** Run a shell command, capture stdout/stderr, return exit code. */
export const runShellAndCapture = (cmd: string, cwd: string, timeoutMs: number): Promise<ShellResult> =>
  new Promise(ok => {
    exec(cmd, { cwd: cwd || undefined, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      ok({ stdout: stdout || '', stderr: stderr || '', code: err?.code ?? 0 });
    });
  });

/** Strip UTF-8 BOM from a string. */
export const stripBom = (s: string) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
