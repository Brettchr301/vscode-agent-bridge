import * as vscode from 'vscode';
import * as fs from 'fs';
import { RouteModule } from '../types';
import { send } from '../helpers';
import { chlog } from '../state';

const uniq = (l: typeof chlog) => [...new Set(l.map(c => c.path))];

export const workspaceRoutes: RouteModule = async ({ meth, pathStr, qp, b, res }) => {

  // GET /workspace-info
  if (meth === 'GET' && pathStr === '/workspace-info') {
    const ed = vscode.window.activeTextEditor;
    send(res, 200, {
      ok: true,
      folders: vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [],
      active_file: ed?.document.uri.fsPath ?? null,
      language: ed?.document.languageId ?? null,
      selection: ed ? { start: ed.selection.start.line, end: ed.selection.end.line } : null,
      open_files: vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file').map(d => d.uri.fsPath),
    });
    return true;
  }

  // GET /diagnostics?path=<p>
  if (meth === 'GET' && pathStr === '/diagnostics') {
    const fp    = qp.path ? vscode.Uri.file(decodeURIComponent(qp.path)) : undefined;
    const diags = fp
      ? vscode.languages.getDiagnostics(fp)
      : vscode.languages.getDiagnostics().flatMap(([, d]) => d);
    const items = (Array.isArray(diags) ? diags : diags).map((d: vscode.Diagnostic) => ({
      severity: ['Error', 'Warning', 'Info', 'Hint'][d.severity] ?? 'Unknown',
      message:  d.message,
      range:    { start: d.range.start.line, end: d.range.end.line },
      source:   d.source,
    }));
    send(res, 200, { ok: true, count: items.length, items });
    return true;
  }

  // GET /changes-since?ts=<ms>
  if (meth === 'GET' && pathStr === '/changes-since') {
    const since = parseInt(qp.ts ?? '0', 10);
    const files = uniq(chlog.filter(c => c.ts > since));
    send(res, 200, { ok: true, since, files, count: files.length });
    return true;
  }

  // POST /search-workspace  { pattern, path_glob?, max_results?, case_sensitive? }
  if (meth === 'POST' && pathStr === '/search-workspace') {
    const pattern = String(b.pattern ?? '').trim();
    if (!pattern) { send(res, 400, { ok: false, error: 'pattern required' }); return true; }
    const glob   = String(b.path_glob ?? '**/*');
    const maxRes = Math.min(Number(b.max_results ?? 200), 1000);
    const cs     = b.case_sensitive === true;
    try {
      const files = await vscode.workspace.findFiles(glob, '**/{node_modules,.git,__pycache__}/**', 5000);
      const re    = new RegExp(pattern, cs ? 'g' : 'gi');
      const results: { file: string; line: number; text: string }[] = [];
      for (const f of files) {
        if (results.length >= maxRes) break;
        try {
          const txt = fs.readFileSync(f.fsPath, 'utf-8');
          txt.split('\n').forEach((ln, i) => {
            re.lastIndex = 0;
            if (re.test(ln) && results.length < maxRes)
              results.push({ file: f.fsPath, line: i + 1, text: ln.slice(0, 200) });
          });
        } catch {}
      }
      send(res, 200, { ok: true, matches: results, total: results.length, truncated: results.length >= maxRes });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
