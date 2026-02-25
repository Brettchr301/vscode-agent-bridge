import * as vscode from 'vscode';
import { RouteModule } from '../types';
import { send, runShellAndCapture } from '../helpers';

export const gitRoutes: RouteModule = async ({ meth, pathStr, qp, b, res }) => {

  // GET /git-status
  if (meth === 'GET' && pathStr === '/git-status') {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    try {
      const [branch, log, status] = await Promise.all([
        runShellAndCapture('git branch --show-current', cwd, 8000),
        runShellAndCapture('git log -1 --format="%H|%s|%ar|%an"', cwd, 8000),
        runShellAndCapture('git status --porcelain', cwd, 8000),
      ]);
      const lines       = status.stdout.trim().split('\n').filter(Boolean);
      const [hash, subject, when, author] = (log.stdout.trim().replace(/"/g, '')).split('|');
      send(res, 200, {
        ok: true,
        branch: branch.stdout.trim(),
        last_commit: { hash: hash?.slice(0, 8), subject, when, author },
        uncommitted_files: lines.length,
        staged_files: lines.filter(l => !'? '.includes(l[0])).length,
        status_lines: lines.slice(0, 50),
      });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /git-commit  { message, add_all?, cwd? }
  if (meth === 'POST' && pathStr === '/git-commit') {
    const msg = String(b.message ?? b.msg ?? '').trim();
    if (!msg) { send(res, 400, { ok: false, error: 'message required' }); return true; }
    const cwd = String(b.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    try {
      if (b.add_all !== false) await runShellAndCapture('git add -A', cwd, 10_000);
      const r = await runShellAndCapture(`git commit -m "${msg.replace(/"/g, "'")}"`, cwd, 15_000);
      if (r.code !== 0 && !r.stdout.includes('nothing to commit'))
        throw new Error(r.stderr || r.stdout);
      send(res, 200, { ok: true, stdout: r.stdout.trim(), code: r.code });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /git-push  { remote?, branch?, cwd? }
  if (meth === 'POST' && pathStr === '/git-push') {
    const cwd    = String(b.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
    const remote = String(b.remote ?? 'origin');
    const branch = String(b.branch ?? '');
    try {
      const r = await runShellAndCapture(
        branch ? `git push ${remote} ${branch}` : `git push ${remote}`, cwd, 30_000);
      send(res, 200, { ok: r.code === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.code });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // GET /git-diff?staged=1
  if (meth === 'GET' && pathStr === '/git-diff') {
    const cwd    = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const staged = qp['staged'] === '1' || qp['staged'] === 'true';
    try {
      const r = await runShellAndCapture(staged ? 'git diff --cached' : 'git diff', cwd, 10_000);
      send(res, 200, { ok: true, diff: r.stdout.slice(0, 50_000), truncated: r.stdout.length > 50_000 });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
