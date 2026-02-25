import * as vscode from 'vscode';
import * as fs from 'fs';
import * as np from 'path';
import { RouteContext, RouteModule } from '../types';
import { send, readText, mkdirFor } from '../helpers';
import { applyEdit } from '../copilot';

export const filesystemRoutes: RouteModule = async ({ meth, pathStr, qp, b, res }) => {

  // GET /read-file?path=<p>
  if (meth === 'GET' && pathStr === '/read-file') {
    const fp = decodeURIComponent(qp.path ?? '');
    if (!fp) { send(res, 400, { ok: false, error: 'path required' }); return true; }
    try {
      const content = await readText(fp);
      send(res, 200, { ok: true, path: fp, content, lines: content.split('\n').length });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // GET /list-dir?path=<p>
  if (meth === 'GET' && pathStr === '/list-dir') {
    const dp = decodeURIComponent(qp.path ?? '');
    if (!dp) { send(res, 400, { ok: false, error: 'path required' }); return true; }
    try {
      const entries = fs.readdirSync(dp, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: np.join(dp, e.name),
      }));
      send(res, 200, { ok: true, path: dp, items, count: items.length });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /write-file  { path, content, create_dirs? }
  if (meth === 'POST' && pathStr === '/write-file') {
    const fp      = String(b.path ?? '').trim();
    const content = String(b.content ?? '');
    if (!fp) { send(res, 400, { ok: false, error: 'path required' }); return true; }
    try {
      if (b.create_dirs !== false) mkdirFor(fp);
      fs.writeFileSync(fp, content, 'utf-8');
      try { await vscode.workspace.openTextDocument(vscode.Uri.file(fp)); } catch {}
      send(res, 200, { ok: true, path: fp, bytes: Buffer.byteLength(content) });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /apply-edit  { path, old_text, new_text }
  if (meth === 'POST' && pathStr === '/apply-edit') {
    const fp = String(b.path ?? '').trim();
    const ot = String(b.old_text ?? '');
    const nt = String(b.new_text ?? '');
    if (!fp || !ot) { send(res, 400, { ok: false, error: 'path and old_text required' }); return true; }
    try {
      await applyEdit(fp, ot, nt);
      send(res, 200, { ok: true, path: fp });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /insert-text  { text, path?, line?, column? }
  if (meth === 'POST' && pathStr === '/insert-text') {
    const text = String(b.text ?? '');
    const fp   = b.path ? String(b.path) : null;
    try {
      if (fp) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
        await vscode.window.showTextDocument(doc);
      }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { send(res, 400, { ok: false, error: 'No active editor' }); return true; }
      let pos = ed.selection.active;
      if (typeof b.line === 'number')
        pos = new vscode.Position(Math.max(0, (b.line as number) - 1), typeof b.column === 'number' ? (b.column as number) : 0);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(ed.document.uri, pos, text);
      await vscode.workspace.applyEdit(edit);
      await ed.document.save();
      send(res, 200, { ok: true, inserted_at: { line: pos.line, col: pos.character } });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
