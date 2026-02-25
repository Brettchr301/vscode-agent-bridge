import * as vscode from 'vscode';
import { RouteModule } from '../types';
import { send } from '../helpers';

export const editorRoutes: RouteModule = async ({ meth, pathStr, qp, b, res }) => {

  // POST /open-file  { path, line? }
  if (meth === 'POST' && pathStr === '/open-file') {
    const fp = String(b.path ?? '').trim();
    if (!fp) { send(res, 400, { ok: false, error: 'path required' }); return true; }
    try {
      const doc  = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
      const opts: vscode.TextDocumentShowOptions = {};
      if (typeof b.line === 'number') {
        const pos = new vscode.Position(Math.max(0, (b.line as number) - 1), 0);
        opts.selection = new vscode.Range(pos, pos);
      }
      await vscode.window.showTextDocument(doc, opts);
      send(res, 200, { ok: true, lines: doc.lineCount });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /save-all
  if (meth === 'POST' && pathStr === '/save-all') {
    await vscode.workspace.saveAll(false);
    send(res, 200, { ok: true });
    return true;
  }

  // POST /show-message  { message, level? }
  if (meth === 'POST' && pathStr === '/show-message') {
    const msg = String(b.message ?? '').trim();
    const lvl = String(b.level ?? 'info');
    if (lvl === 'error')    vscode.window.showErrorMessage(`Agent: ${msg}`);
    else if (lvl === 'warn') vscode.window.showWarningMessage(`Agent: ${msg}`);
    else                    vscode.window.showInformationMessage(`Agent: ${msg}`);
    send(res, 200, { ok: true });
    return true;
  }

  // POST /format-file  { path? }
  if (meth === 'POST' && pathStr === '/format-file') {
    const fp = String(b.path ?? '').trim();
    try {
      const uri = fp ? vscode.Uri.file(fp) : vscode.window.activeTextEditor?.document.uri;
      if (!uri) { send(res, 400, { ok: false, error: 'path required or open a file' }); return true; }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      await doc.save();
      send(res, 200, { ok: true, path: uri.fsPath });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // GET /symbols?path=<p>  — code outline
  if (meth === 'GET' && pathStr === '/symbols') {
    const fp = String(qp['path'] ?? '').trim();
    try {
      const uri = fp ? vscode.Uri.file(fp) : vscode.window.activeTextEditor?.document.uri;
      if (!uri) { send(res, 400, { ok: false, error: 'path required or open a file' }); return true; }
      const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri) ?? [];
      const flatten = (s: vscode.DocumentSymbol[], depth = 0): object[] =>
        s.flatMap(x => [
          { name: x.name, kind: vscode.SymbolKind[x.kind], line: x.range.start.line + 1, depth },
          ...flatten(x.children ?? [], depth + 1),
        ]);
      send(res, 200, { ok: true, symbols: flatten(syms), file: uri.fsPath });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /rename-symbol  { old_name, new_name, path? }
  if (meth === 'POST' && pathStr === '/rename-symbol') {
    const oldName = String(b.old_name ?? '').trim();
    const newName = String(b.new_name ?? '').trim();
    if (!oldName || !newName) { send(res, 400, { ok: false, error: 'old_name and new_name required' }); return true; }
    try {
      const fp  = String(b.path ?? '').trim();
      const uri = fp ? vscode.Uri.file(fp) : vscode.window.activeTextEditor?.document.uri;
      if (!uri) { send(res, 400, { ok: false, error: 'path required or open a file' }); return true; }
      const doc  = await vscode.workspace.openTextDocument(uri);
      const idx  = doc.getText().indexOf(oldName);
      if (idx < 0) { send(res, 400, { ok: false, error: `'${oldName}' not found in file` }); return true; }
      await vscode.window.showTextDocument(doc);
      const pos = doc.positionAt(idx);
      await vscode.commands.executeCommand('editor.action.rename', uri, pos);
      send(res, 200, { ok: true, note: `Rename dialog opened: ${oldName} → ${newName}` });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
