import * as vscode from 'vscode';
import { exec } from 'child_process';
import { RouteModule } from '../types';
import { send, runShellAndCapture } from '../helpers';

export const terminalRoutes: RouteModule = async ({ meth, pathStr, b, res }) => {

  // POST /run-terminal  { command, cwd?, capture_output? }
  if (meth === 'POST' && pathStr === '/run-terminal') {
    const cmd = String(b.command ?? '').trim();
    if (!cmd) { send(res, 400, { ok: false, error: 'command required' }); return true; }
    if (b.capture_output === true) {
      try {
        const r = await runShellAndCapture(cmd, String(b.cwd ?? ''), Number(b.timeout ?? 120) * 1000);
        send(res, 200, { ok: true, stdout: r.stdout.slice(0, 8000), stderr: r.stderr.slice(0, 2000), exit_code: r.code });
      } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
      return true;
    }
    const name = `Agent-${Date.now()}`;
    const term = vscode.window.createTerminal({ name, cwd: b.cwd ? vscode.Uri.file(String(b.cwd)) : undefined });
    term.sendText(cmd);
    term.show();
    send(res, 200, { ok: true, terminal_name: name });
    return true;
  }

  // POST /exec-command  { command, args? }
  if (meth === 'POST' && pathStr === '/exec-command') {
    const cmd = String(b.command ?? '').trim();
    if (!cmd) { send(res, 400, { ok: false, error: 'command required' }); return true; }
    try {
      const args   = Array.isArray(b.args) ? b.args : [];
      const result = await vscode.commands.executeCommand(cmd, ...args);
      send(res, 200, { ok: true, result: result ?? null });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /desktop-type  { app, text, window_title?, delay_ms? }  Windows only
  if (meth === 'POST' && pathStr === '/desktop-type') {
    const appName    = String(b.app ?? 'notepad.exe');
    const textToType = String(b.text ?? '');
    const winTitle   = String(b.window_title ?? '');
    const delayMs    = Number(b.delay_ms ?? 2000);
    const ps = [
      `Start-Process "${appName}"`,
      `Start-Sleep -Milliseconds ${delayMs}`,
      `$sh = New-Object -ComObject WScript.Shell`,
      winTitle
        ? `$sh.AppActivate("${winTitle.replace(/"/g, '`"')}")`
        : `$sh.AppActivate("${appName.replace('.exe', '')}")`,
      `Start-Sleep -Milliseconds 400`,
      `$sh.SendKeys("${textToType.replace(/[+^%~(){}]/g, '{$&}').replace(/"/g, '`"')}")`,
    ].join('\n');
    await new Promise<void>(resolve => {
      exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, () => resolve());
    });
    send(res, 200, { ok: true, app: appName, typed: textToType });
    return true;
  }

  // POST /schedule  { command, delay_ms, cwd?, capture_output? }
  if (meth === 'POST' && pathStr === '/schedule') {
    const cmd     = String(b.command ?? '').trim();
    const delayMs = Math.min(Number(b.delay_ms ?? 1000), 3_600_000);
    if (!cmd) { send(res, 400, { ok: false, error: 'command required' }); return true; }
    const cwd = String(b.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    const id  = `sched_${Date.now()}`;
    setTimeout(() => {
      if (b.capture_output) {
        runShellAndCapture(cmd, cwd, 120_000).catch(() => {});
      } else {
        const t = vscode.window.createTerminal({ name: `Scheduled-${id}`, cwd: vscode.Uri.file(cwd) });
        t.sendText(cmd); t.show();
      }
    }, delayMs);
    send(res, 200, { ok: true, id, command: cmd, runs_in_ms: delayMs });
    return true;
  }

  return false;
};
