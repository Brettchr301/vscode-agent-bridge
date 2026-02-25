import * as vscode from 'vscode';
import * as http  from 'http';
import * as https from 'https';
import { exec } from 'child_process';
import { RouteModule } from '../types';
import { send, runShellAndCapture } from '../helpers';

export const systemRoutes: RouteModule = async ({ meth, pathStr, qp, b, res }) => {

  // GET /clipboard
  if (meth === 'GET' && pathStr === '/clipboard') {
    try {
      const text = await vscode.env.clipboard.readText();
      send(res, 200, { ok: true, text, length: text.length });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /clipboard  { text }
  if (meth === 'POST' && pathStr === '/clipboard') {
    const text = String(b.text ?? b.content ?? '');
    try {
      await vscode.env.clipboard.writeText(text);
      send(res, 200, { ok: true, length: text.length });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // GET /processes?filter=<name>
  if (meth === 'GET' && pathStr === '/processes') {
    const filter = String(qp['filter'] ?? '').toLowerCase();
    try {
      const r = await runShellAndCapture(
        'powershell -NoProfile -Command "Get-Process | Select-Object Name,Id,CPU,WorkingSet | ConvertTo-Json -Compress"',
        process.cwd(), 10_000);
      let procs = JSON.parse(r.stdout.trim()) as { Name: string; Id: number; CPU: number; WorkingSet: number }[];
      if (filter) procs = procs.filter(p => p.Name.toLowerCase().includes(filter));
      send(res, 200, { ok: true, processes: procs.slice(0, 200) });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /kill-process  { name?, pid?, force? }
  if (meth === 'POST' && pathStr === '/kill-process') {
    const name  = String(b.name ?? '').trim();
    const pid   = Number(b.pid ?? 0);
    const force = b.force !== false;
    if (!name && !pid) { send(res, 400, { ok: false, error: 'name or pid required' }); return true; }
    try {
      const cmd = pid
        ? `Stop-Process -Id ${pid} ${force ? '-Force' : ''} -ErrorAction SilentlyContinue`
        : `Stop-Process -Name "${name}" ${force ? '-Force' : ''} -ErrorAction SilentlyContinue`;
      const r = await runShellAndCapture(`powershell -NoProfile -Command "${cmd}"`, process.cwd(), 10_000);
      send(res, 200, { ok: true, stdout: r.stdout.trim(), stderr: r.stderr.trim() });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /http-proxy  { url, method?, headers?, body?, timeout_ms? }
  if (meth === 'POST' && pathStr === '/http-proxy') {
    const targetUrl = String(b.url ?? '').trim();
    if (!targetUrl) { send(res, 400, { ok: false, error: 'url required' }); return true; }
    const targetMethod  = String(b.method ?? 'GET').toUpperCase();
    const targetHeaders = (b.headers as Record<string, string>) ?? {};
    const targetBody    = b.body ? String(b.body) : undefined;
    const tMs = Math.min(Number(b.timeout_ms ?? 30_000), 120_000);
    try {
      const u       = new URL(targetUrl);
      const isHttps = u.protocol === 'https:';
      const opts    = {
        hostname: u.hostname,
        port:     u.port || (isHttps ? 443 : 80),
        path:     u.pathname + (u.search ?? ''),
        method:   targetMethod,
        headers:  { 'User-Agent': 'AgentBridge/3.4', ...targetHeaders,
          ...(targetBody ? { 'Content-Length': Buffer.byteLength(targetBody) } : {}) },
      };
      const { status, body: rBody, hdrs } = await new Promise<{ status: number; body: string; hdrs: Record<string, string> }>((resolve, reject) => {
        const cb = (r2: http.IncomingMessage) => {
          let d = ''; r2.on('data', (c: Buffer) => d += c);
          r2.on('end', () => resolve({ status: r2.statusCode ?? 0, body: d.slice(0, 1_000_000), hdrs: r2.headers as Record<string, string> }));
        };
        const req2 = isHttps ? https.request(opts, cb) : http.request(opts, cb);
        req2.setTimeout(tMs, () => { req2.destroy(); reject(new Error('timeout')); });
        req2.on('error', reject);
        if (targetBody) req2.write(targetBody);
        req2.end();
      });
      send(res, 200, { ok: true, status, body: rBody, headers: hdrs });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // POST /notify  { message, title? }
  if (meth === 'POST' && pathStr === '/notify') {
    const msg   = String(b.message ?? b.text ?? '').trim();
    const title = String(b.title ?? 'Agent Bridge');
    if (!msg) { send(res, 400, { ok: false, error: 'message required' }); return true; }
    vscode.window.showInformationMessage(`${title}: ${msg}`);
    const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;`
      + `$t=[Windows.UI.Notifications.ToastTemplateType]::ToastText02;`
      + `$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($t);`
      + `$n=$x.GetElementsByTagName('text');`
      + `$n.Item(0).AppendChild($x.CreateTextNode('${title.replace(/'/g, "`'")}')) | Out-Null;`
      + `$n.Item(1).AppendChild($x.CreateTextNode('${msg.replace(/'/g, "`'")}')) | Out-Null;`
      + `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AgentBridge').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, () => {});
    send(res, 200, { ok: true, message: msg, title });
    return true;
  }

  return false;
};
