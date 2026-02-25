import * as vscode from 'vscode';
import * as fs from 'fs';
import * as np from 'path';
import * as os from 'os';
import { RouteModule } from '../types';
import { send, stripBom } from '../helpers';
import {
  logEntries, chlog, sessions,
  autoDismissTimer, setAutoDismissTimer, activePort,
} from '../state';
import { ACCEPT, REJECT, KEEP_GOING_CMDS, tryCmds } from '../copilot';

const uniq = (l: typeof chlog) => [...new Set(l.map(c => c.path))];

function startAutoDismiss(intervalMs = 1500) {
  if (autoDismissTimer) return;
  setAutoDismissTimer(setInterval(async () => {
    try { await tryCmds(KEEP_GOING_CMDS); } catch {}
    try { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); } catch {}
  }, intervalMs));
}

function stopAutoDismiss() {
  if (autoDismissTimer) { clearInterval(autoDismissTimer); setAutoDismissTimer(null); }
}

export const bridgeRoutes: RouteModule = async ({ meth, pathStr, qp, b, res }) => {

  // GET /health
  if (meth === 'GET' && pathStr === '/health') {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    send(res, 200, {
      ok: true, port: activePort,
      models: models.map(m => m.name),
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      version: '3.4',
    });
    return true;
  }

  // GET /log
  if (meth === 'GET' && pathStr === '/log') {
    send(res, 200, { ok: true, entries: logEntries.slice(-100) });
    return true;
  }

  // POST /auto-dismiss  { active, interval_ms? }
  if (meth === 'POST' && pathStr === '/auto-dismiss') {
    const active     = b.active !== false && b.active !== 'false';
    const intervalMs = Number(b.interval_ms ?? 1500);
    if (active) { startAutoDismiss(intervalMs); send(res, 200, { ok: true, active: true, interval_ms: intervalMs }); }
    else        { stopAutoDismiss();             send(res, 200, { ok: true, active: false }); }
    return true;
  }

  // GET /auto-dismiss
  if (meth === 'GET' && pathStr === '/auto-dismiss') {
    send(res, 200, { ok: true, active: autoDismissTimer !== null });
    return true;
  }

  // GET /pending-approvals
  if (meth === 'GET' && pathStr === '/pending-approvals') {
    const dirty = vscode.workspace.textDocuments
      .filter(d => d.isDirty && d.uri.scheme === 'file')
      .map(d => ({ path: d.uri.fsPath, lang: d.languageId }));
    send(res, 200, { ok: true, count: dirty.length, dirty_docs: dirty });
    return true;
  }

  // POST /watch-start  { label? }
  if (meth === 'POST' && pathStr === '/watch-start') {
    const id = `w_${Date.now()}`;
    sessions.set(id, { startTs: Date.now(), label: String(b.label ?? '') });
    send(res, 200, { ok: true, watch_id: id, started_ts: Date.now() });
    return true;
  }

  // GET /watch-result?id=<id>
  if (meth === 'GET' && pathStr === '/watch-result') {
    const sess = sessions.get(qp.id ?? '');
    if (!sess) { send(res, 404, { ok: false, error: 'watch_id not found' }); return true; }
    const files = uniq(chlog.filter(c => c.ts > sess.startTs));
    send(res, 200, { ok: true, watch_id: qp.id, files_changed: files });
    return true;
  }

  // POST /accept-edits
  if (meth === 'POST' && pathStr === '/accept-edits') {
    const ran = await tryCmds(ACCEPT);
    await vscode.workspace.saveAll(false);
    send(res, 200, { ok: true, commands_run: ran });
    return true;
  }

  // POST /reject-edits
  if (meth === 'POST' && pathStr === '/reject-edits') {
    const ran = await tryCmds(REJECT);
    send(res, 200, { ok: true, commands_run: ran });
    return true;
  }

  // POST /keep-going
  if (meth === 'POST' && pathStr === '/keep-going') {
    const ran = await tryCmds(KEEP_GOING_CMDS);
    await vscode.workspace.saveAll(false);
    try { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); } catch {}
    send(res, 200, { ok: true, commands_run: ran, note: 'Dismissed dialogs + saved all' });
    return true;
  }

  // GET /config
  if (meth === 'GET' && pathStr === '/config') {
    try {
      const cfgPath = np.join(os.homedir(), '.agent-bridge', 'config.json');
      const data    = fs.existsSync(cfgPath)
        ? JSON.parse(stripBom(fs.readFileSync(cfgPath, 'utf-8')))
        : {};
      const safe = { ...data };
      for (const k of ['slack_bot_token', 'auth_token', 'deepseek_api_key', 'openai_api_key'])
        if (safe[k]) safe[k] = '***REDACTED***';
      send(res, 200, { ok: true, config: safe, path: cfgPath });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /config  { key, value }
  if (meth === 'POST' && pathStr === '/config') {
    const key   = String(b.key ?? '').trim();
    const value = b.value;
    if (!key) { send(res, 400, { ok: false, error: 'key required' }); return true; }
    const blocked = ['slack_bot_token', 'auth_token', 'deepseek_api_key', 'openai_api_key'];
    if (blocked.includes(key)) {
      send(res, 403, { ok: false, error: `'${key}' is write-protected — edit ~/.agent-bridge/config.json manually` });
      return true;
    }
    try {
      const cfgPath = np.join(os.homedir(), '.agent-bridge', 'config.json');
      const dir     = np.dirname(cfgPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data    = fs.existsSync(cfgPath) ? JSON.parse(stripBom(fs.readFileSync(cfgPath, 'utf-8'))) : {};
      data[key] = value;
      fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), 'utf-8');
      send(res, 200, { ok: true, key, note: 'config updated' });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
