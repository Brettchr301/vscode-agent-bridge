import * as vscode from 'vscode';
import { RouteModule } from '../types';
import { send, readText, log } from '../helpers';
import { chlog, sessions } from '../state';
import { callCopilot, buildPromptWithContext, ACCEPT, tryCmds } from '../copilot';

const uniq = (l: typeof chlog) => [...new Set(l.map(c => c.path))];

export const copilotRoutes: RouteModule = async ({ meth, pathStr, b, res }) => {

  // POST /prompt  { prompt, model?, system?, timeout?, context_files? }
  if (meth === 'POST' && pathStr === '/prompt') {
    const p = String(b.prompt ?? '').trim();
    if (!p) { send(res, 400, { ok: false, error: 'prompt required' }); return true; }
    const t0 = Date.now();
    try {
      const ctxPaths = Array.isArray(b.context_files) ? (b.context_files as string[]) : [];
      const fullPrompt = await buildPromptWithContext(p, ctxPaths, b.active_file_context === true || b.active_file_context === 'true');
      const r = await callCopilot(fullPrompt, b.system as string | undefined, b.model as string | undefined, Number(b.timeout ?? 300) * 1000);
      const out = { ok: true, ...r, elapsed_ms: Date.now() - t0, context_files_injected: ctxPaths.length };
      log('POST', '/prompt', { prompt: p.slice(0, 100) }, out);
      send(res, 200, out);
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /copilot-task  { prompt, auto_accept?, watch_secs?, timeout?, context_files? }
  if (meth === 'POST' && pathStr === '/copilot-task') {
    const p = String(b.prompt ?? '').trim();
    if (!p) { send(res, 400, { ok: false, error: 'prompt required' }); return true; }
    const autoAccept = b.auto_accept !== false;
    const watchMs    = Math.min(Number(b.watch_secs ?? 60), 300) * 1000;
    const timeoutMs  = Number(b.timeout ?? 300) * 1000;
    const t0         = Date.now();
    const watchId    = `w_${t0}`;
    sessions.set(watchId, { startTs: t0, label: p.slice(0, 80) });

    const ctxPaths    = Array.isArray(b.context_files) ? (b.context_files as string[]) : [];
    const fullPrompt  = await buildPromptWithContext(p, ctxPaths, !!b.active_file_context);

    let llm_response = '', model_used = '';

    // Start auto-dismiss loop so Allow/Continue/Keep buttons get clicked in real-time
    let autoDismissInterval: NodeJS.Timeout | null = null;
    if (autoAccept) {
      autoDismissInterval = setInterval(async () => {
        try { await vscode.commands.executeCommand('workbench.action.chat.acceptAllCopilotEdits'); } catch {}
        try { await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); } catch {}
      }, 1200);
    }

    try {
      const r = await callCopilot(fullPrompt, b.system as string | undefined, b.model as string | undefined, timeoutMs);
      llm_response = r.text; model_used = r.model_used;
    } catch (e) {
      if (autoDismissInterval) clearInterval(autoDismissInterval);
      send(res, 500, { ok: false, error: `Copilot call failed: ${e}` }); return true;
    }

    await new Promise(r => setTimeout(r, watchMs));
    if (autoDismissInterval) clearInterval(autoDismissInterval);

    const changedFiles = uniq(chlog.filter(c => c.ts > t0));
    let accepted = false;
    if (autoAccept) {
      await tryCmds(ACCEPT);
      await vscode.workspace.saveAll(false);
      accepted = true;
    }
    const diff_summary = await Promise.all(changedFiles.slice(0, 10).map(async f => {
      try { const t = await readText(f); return { path: f, lines: t.split('\n').length, preview: t.slice(0, 6000) }; }
      catch { return { path: f, lines: -1, preview: '' }; }
    }));
    const out = {
      ok: true, watch_id: watchId, llm_response, model_used,
      files_changed: changedFiles, diff_summary, accepted,
      context_files_injected: ctxPaths.length, elapsed_ms: Date.now() - t0,
    };
    log('POST', '/copilot-task', { prompt: p.slice(0, 100) }, { files: changedFiles.length, model: model_used });
    send(res, 200, out);
    return true;
  }

  return false;
};
