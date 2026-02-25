/**
 * src/routes/automations.ts
 *
 * Rule-based scheduling and automation engine.
 *
 * Supports three trigger types:
 *   time     — run at a fixed HH:MM every day
 *   cron     — basic 5-field cron expression  (min hr dom mon dow)
 *   presence — fire when presence state changes (all_away | someone_home |
 *               room_empty:<name> | room_occupied:<name>)
 *
 * Actions can be:
 *   iot_control  — call POST /iot/control
 *   iot_command  — call POST /iot/command  (natural language)
 *   http         — arbitrary HTTP request to any URL
 *   slack        — POST /slack-post
 *   notify       — VS Code information-message via POST /bridge/notify
 *
 * Rules are persisted to ~/.agent-bridge/automations.json
 */
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as http from 'http';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AutomationAction {
  type: 'iot_control' | 'iot_command' | 'http' | 'slack' | 'notify';
  // iot_control
  device_id?: string;
  action?: string;
  params?: Record<string, unknown>;
  // iot_command
  text?: string;
  // http
  method?: string;
  url?: string;
  body?: unknown;
  // slack
  channel?: string;
  message?: string;
  // notify
  level?: 'info' | 'warn' | 'error';
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  /** Trigger type */
  trigger: 'time' | 'cron' | 'presence';
  /** HH:MM  (for trigger=time) */
  time?: string;
  /** 5-field cron string  (for trigger=cron) */
  cron?: string;
  /** Presence event  (for trigger=presence) */
  presence_event?: string;
  /** Optional conditions checked before firing */
  conditions?: AutomationCondition[];
  actions: AutomationAction[];
  /** Minimum ms between successive firings (anti-flap) */
  cooldown_ms?: number;
  /** ISO timestamp of last fire */
  last_fired?: string;
  /** Running counter */
  fire_count?: number;
  created: string;
}

export interface AutomationCondition {
  type: 'time_between' | 'presence_empty' | 'presence_occupied' | 'day_of_week';
  from?: string;   // HH:MM
  to?: string;     // HH:MM
  room?: string;
  days?: string[]; // ['mon','tue',…]
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const DATA_DIR   = path.join(os.homedir(), '.agent-bridge');
const RULES_FILE = path.join(DATA_DIR, 'automations.json');

let rulesCache: AutomationRule[] = [];

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

export function loadRules(): AutomationRule[] {
  try {
    ensureDir();
    if (!fs.existsSync(RULES_FILE)) return [];
    const raw = fs.readFileSync(RULES_FILE, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as AutomationRule[];
  } catch {
    return [];
  }
}

function saveRules(rules: AutomationRule[]) {
  ensureDir();
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
}

rulesCache = loadRules();

// ─── Cron parser (basic 5-field) ──────────────────────────────────────────────

function parseCronField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return (value - min) % step === 0;
  }
  const parts = field.split(',');
  for (const p of parts) {
    if (p.includes('-')) {
      const [lo, hi] = p.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(p, 10) === value) return true;
    }
  }
  return false;
}

function cronMatches(cron: string, now: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hrF, domF, monF, dowF] = fields;
  return (
    parseCronField(minF, now.getMinutes(), 0, 59) &&
    parseCronField(hrF,  now.getHours(),   0, 23) &&
    parseCronField(domF, now.getDate(),    1, 31) &&
    parseCronField(monF, now.getMonth() + 1, 1, 12) &&
    parseCronField(dowF, now.getDay(),     0, 6)
  );
}

// ─── Condition checker ────────────────────────────────────────────────────────

let _getOccupiedRooms: () => string[] = () => [];
let _isAnyoneHome:     () => boolean  = () => false;

/** Called once at startup to inject presence helpers (avoids circular dep). */
export function injectPresenceFns(
  getOccupied: () => string[],
  anyoneHome:  () => boolean,
) {
  _getOccupiedRooms = getOccupied;
  _isAnyoneHome     = anyoneHome;
}

function evaluateCondition(cond: AutomationCondition, now: Date): boolean {
  if (cond.type === 'time_between' && cond.from && cond.to) {
    const toMins = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const cur = now.getHours() * 60 + now.getMinutes();
    return cur >= toMins(cond.from) && cur <= toMins(cond.to);
  }
  if (cond.type === 'presence_empty' && cond.room) {
    return !_getOccupiedRooms().map(r => r.toLowerCase()).includes(cond.room.toLowerCase());
  }
  if (cond.type === 'presence_occupied' && cond.room) {
    return _getOccupiedRooms().map(r => r.toLowerCase()).includes(cond.room.toLowerCase());
  }
  if (cond.type === 'day_of_week' && cond.days) {
    const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
    const today    = dayNames[now.getDay()];
    return cond.days.map(d => d.toLowerCase()).includes(today);
  }
  return true;
}

// ─── Action executor ──────────────────────────────────────────────────────────

import { activePort } from '../state';

function bridgePost(endpoint: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: activePort,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', (e) => resolve({ error: String(e) }));
    req.write(body);
    req.end();
  });
}

function externalHttp(method: string, url: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const body   = payload ? JSON.stringify(payload) : undefined;
    const parsed = new URL(url);
    const opts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const mod = parsed.protocol === 'https:'
      ? require('https') as typeof http
      : http;
    const req = mod.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', (e) => resolve({ error: String(e) }));
    if (body) req.write(body);
    req.end();
  });
}

async function executeActions(rule: AutomationRule): Promise<void> {
  for (const act of rule.actions) {
    try {
      if (act.type === 'iot_control') {
        await bridgePost('/iot/control', {
          id:     act.device_id,
          action: act.action,
          params: act.params ?? {},
        });
      } else if (act.type === 'iot_command') {
        await bridgePost('/iot/command', {
          text:      act.text,
          device_id: act.device_id,
        });
      } else if (act.type === 'http' && act.url) {
        await externalHttp(act.method ?? 'POST', act.url, act.body);
      } else if (act.type === 'slack') {
        await bridgePost('/slack-post', {
          channel: act.channel,
          text:    act.message,
        });
      } else if (act.type === 'notify') {
        await bridgePost('/bridge/notify', {
          message: act.message,
          level:   act.level ?? 'info',
        });
      }
    } catch (err) {
      console.error(`[automations] action ${act.type} failed for rule ${rule.id}:`, err);
    }
  }
}

// ─── Presence event state ─────────────────────────────────────────────────────

let _lastPresenceSnap: {
  anyoneHome: boolean;
  occupied: string[];
} = { anyoneHome: false, occupied: [] };

/** Called by the engine loop after a presence scan. */
function detectPresenceEvents(newAnyoneHome: boolean, newOccupied: string[]): string[] {
  const events: string[] = [];
  const prev = _lastPresenceSnap;

  if (prev.anyoneHome && !newAnyoneHome) events.push('all_away');
  if (!prev.anyoneHome && newAnyoneHome) events.push('someone_home');

  const prevSet = new Set(prev.occupied.map(r => r.toLowerCase()));
  const newSet  = new Set(newOccupied.map(r => r.toLowerCase()));

  for (const room of newSet) {
    if (!prevSet.has(room)) events.push(`room_occupied:${room}`);
  }
  for (const room of prevSet) {
    if (!newSet.has(room)) events.push(`room_empty:${room}`);
  }

  _lastPresenceSnap = { anyoneHome: newAnyoneHome, occupied: newOccupied };
  return events;
}

// ─── Engine tick ─────────────────────────────────────────────────────────────

let _engineTimer: NodeJS.Timeout | null = null;
const TICK_MS = 60_000; // check every 60 s

async function engineTick() {
  const now   = new Date();
  const rules = rulesCache.filter(r => r.enabled);

  // Presence snapshot (null-safe)
  let presenceEvents: string[] = [];
  try {
    const newAny   = _isAnyoneHome();
    const newRooms = _getOccupiedRooms();
    presenceEvents = detectPresenceEvents(newAny, newRooms);
  } catch {}

  for (const rule of rules) {
    let shouldFire = false;

    // Cooldown check
    if (rule.cooldown_ms && rule.last_fired) {
      const elapsed = now.getTime() - new Date(rule.last_fired).getTime();
      if (elapsed < rule.cooldown_ms) continue;
    }

    if (rule.trigger === 'time' && rule.time) {
      const [h, m] = rule.time.split(':').map(Number);
      shouldFire = now.getHours() === h && now.getMinutes() === m;
    } else if (rule.trigger === 'cron' && rule.cron) {
      shouldFire = cronMatches(rule.cron, now);
    } else if (rule.trigger === 'presence' && rule.presence_event) {
      shouldFire = presenceEvents.includes(rule.presence_event);
    }

    if (!shouldFire) continue;

    // Evaluate optional conditions
    if (rule.conditions?.length) {
      const ok = rule.conditions.every(c => evaluateCondition(c, now));
      if (!ok) continue;
    }

    // Fire!
    rule.last_fired = now.toISOString();
    rule.fire_count = (rule.fire_count ?? 0) + 1;
    saveRules(rulesCache);

    // Execute async (don't await — don't block the engine tick)
    executeActions(rule).catch(e =>
      console.error(`[automations] rule ${rule.id} actions error:`, e),
    );
  }
}

// ─── Public start/stop ────────────────────────────────────────────────────────

export function startAutomationEngine() {
  if (_engineTimer) return;
  _engineTimer = setInterval(() => {
    engineTick().catch(e => console.error('[automations] tick error:', e));
  }, TICK_MS);
  console.log('[automations] engine started — tick every 60 s');
}

export function stopAutomationEngine() {
  if (_engineTimer) {
    clearInterval(_engineTimer);
    _engineTimer = null;
  }
}

/** Expose for unit tests */
export { engineTick, cronMatches, evaluateCondition, detectPresenceEvents };

// ─── HTTP Route handler ───────────────────────────────────────────────────────

import { RouteContext } from '../types';
import { send }        from '../helpers';

function makeId() {
  return `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function automationsRoutes(ctx: RouteContext): Promise<boolean> {
  const { meth, pathStr, b, res } = ctx;

  // GET /automations — list all rules
  if (meth === 'GET' && pathStr === '/automations') {
    send(res, 200, { ok: true, rules: rulesCache });
    return true;
  }

  // GET /automations/status — engine health
  if (meth === 'GET' && pathStr === '/automations/status') {
    send(res, 200, {
      ok:      true,
      running: _engineTimer !== null,
      count:   rulesCache.length,
      enabled: rulesCache.filter(r => r.enabled).length,
      tick_ms: TICK_MS,
    });
    return true;
  }

  // POST /automations — create rule
  if (meth === 'POST' && pathStr === '/automations') {
    const rule: AutomationRule = {
      id:         (b.id      as string)                     ?? makeId(),
      name:       (b.name    as string)                     ?? 'Unnamed rule',
      enabled:    b.enabled !== false,
      trigger:    (b.trigger as AutomationRule['trigger'])  ?? 'time',
      time:       b.time     as string | undefined,
      cron:       b.cron     as string | undefined,
      presence_event: b.presence_event as string | undefined,
      conditions: (b.conditions as AutomationCondition[])  ?? [],
      actions:    (b.actions    as AutomationAction[])      ?? [],
      cooldown_ms: (b.cooldown_ms as number)                ?? 60_000,
      fire_count:  0,
      created:     new Date().toISOString(),
    };
    rulesCache.push(rule);
    saveRules(rulesCache);
    send(res, 201, { ok: true, rule });
    return true;
  }

  // PUT /automations/:id — update rule
  const putMatch = pathStr.match(/^\/automations\/([^/]+)$/);
  if (meth === 'PUT' && putMatch) {
    const idx = rulesCache.findIndex(r => r.id === putMatch[1]);
    if (idx === -1) { send(res, 404, { ok: false, error: 'Rule not found' }); return true; }
    rulesCache[idx] = { ...rulesCache[idx], ...b, id: rulesCache[idx].id };
    saveRules(rulesCache);
    send(res, 200, { ok: true, rule: rulesCache[idx] });
    return true;
  }

  // DELETE /automations/:id
  const delMatch = pathStr.match(/^\/automations\/([^/]+)$/);
  if (meth === 'DELETE' && delMatch) {
    const idx = rulesCache.findIndex(r => r.id === delMatch[1]);
    if (idx === -1) { send(res, 404, { ok: false, error: 'Rule not found' }); return true; }
    const removed = rulesCache.splice(idx, 1)[0];
    saveRules(rulesCache);
    send(res, 200, { ok: true, removed });
    return true;
  }

  // POST /automations/:id/run — manually run a rule now
  const runMatch = pathStr.match(/^\/automations\/([^/]+)\/run$/);
  if (meth === 'POST' && runMatch) {
    const rule = rulesCache.find(r => r.id === runMatch[1]);
    if (!rule) { send(res, 404, { ok: false, error: 'Rule not found' }); return true; }
    rule.last_fired = new Date().toISOString();
    rule.fire_count = (rule.fire_count ?? 0) + 1;
    saveRules(rulesCache);
    executeActions(rule).catch(() => {});
    send(res, 200, { ok: true, message: `Rule '${rule.name}' triggered manually` });
    return true;
  }

  // POST /automations/:id/enable|disable
  const toggleMatch = pathStr.match(/^\/automations\/([^/]+)\/(enable|disable)$/);
  if (meth === 'POST' && toggleMatch) {
    const rule = rulesCache.find(r => r.id === toggleMatch[1]);
    if (!rule) { send(res, 404, { ok: false, error: 'Rule not found' }); return true; }
    rule.enabled = toggleMatch[2] === 'enable';
    saveRules(rulesCache);
    send(res, 200, { ok: true, rule });
    return true;
  }

  // POST /automations/engine/start|stop
  if (meth === 'POST' && pathStr === '/automations/engine/start') {
    startAutomationEngine();
    send(res, 200, { ok: true, message: 'Engine started' });
    return true;
  }
  if (meth === 'POST' && pathStr === '/automations/engine/stop') {
    stopAutomationEngine();
    send(res, 200, { ok: true, message: 'Engine stopped' });
    return true;
  }

  return false;
}
