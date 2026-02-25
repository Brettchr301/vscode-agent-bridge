import * as vscode from 'vscode';
import * as https  from 'https';
import * as fs     from 'fs';
import * as np     from 'path';
import * as os     from 'os';
import { RouteModule } from '../types';
import { send, stripBom } from '../helpers';

export const slackRoutes: RouteModule = async ({ meth, pathStr, b, res }) => {

  // POST /slack-post  { text, channel? }
  if (meth === 'POST' && pathStr === '/slack-post') {
    const text = String(b.text ?? b.message ?? '').trim();
    if (!text) { send(res, 400, { ok: false, error: 'text required' }); return true; }
    try {
      const cfg          = vscode.workspace.getConfiguration('agentBridge');
      let slackToken     = cfg.get<string>('slackBotToken', '');
      let slackChannel   = String(b.channel ?? cfg.get<string>('slackChannel', ''));

      if (!slackToken) {
        const sidecars = [
          np.join(os.homedir(), '.agent-bridge', 'config.json'),
          np.join(os.homedir(), 'Documents', 'DeepBrainChat', 'settings.json'),
        ];
        for (const sidecar of sidecars) {
          try {
            const raw  = stripBom(fs.readFileSync(sidecar, 'utf-8'));
            const data = JSON.parse(raw);
            if (data.slack_bot_token) slackToken = data.slack_bot_token;
            if (!slackChannel && data.slack_channel) slackChannel = data.slack_channel;
            if (slackToken) break;
          } catch {}
        }
      }

      if (!slackToken || slackToken.startsWith('xoxb-PASTE')) {
        send(res, 500, { ok: false, error: 'Slack token not configured. Create ~/.agent-bridge/config.json with {"slack_bot_token":"xoxb-...","slack_channel":"C0..."}' });
        return true;
      }

      const payload = JSON.stringify({ channel: slackChannel, text, unfurl_links: false });
      await new Promise<void>((resolve, reject) => {
        const req2 = https.request(
          { hostname: 'slack.com', path: '/api/chat.postMessage', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${slackToken}` } },
          r => {
            let d = ''; r.on('data', c => d += c);
            r.on('end', () => { try { const j = JSON.parse(d); if (j.ok) resolve(); else reject(new Error(j.error)); } catch (e) { reject(e); } });
          });
        req2.on('error', reject);
        req2.write(payload); req2.end();
      });
      send(res, 200, { ok: true, channel: slackChannel });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
