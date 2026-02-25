/**
 * IoT device registry + control route
 *
 * Supports: Home Assistant, Philips Hue, Roomba (via HA or cloud), Shelly,
 * Tasmota, ESPHome, WLED, Tuya cloud, generic REST, and MQTT (via mosquitto_pub).
 *
 * Device registry is persisted to ~/.agent-bridge/iot-devices.json
 *
 * Endpoints
 *   GET  /iot/devices                    list registered devices (tokens redacted)
 *   POST /iot/devices                    register a device
 *   PUT  /iot/devices                    update a device  { id, ...fields }
 *   DELETE /iot/devices?id=              remove a device
 *   GET  /iot/status?id=                 get live state from device
 *   GET  /iot/status-all                 poll all devices
 *   POST /iot/control                    send action  { id, action, params? }
 *   POST /iot/command                    natural-language command  { text, device_id? }
 *   GET  /iot/discover                   scan LAN for known device types
 *   GET  /iot/ha/entities?id=            list Home Assistant entities
 *   POST /iot/ha/service                 call HA service  { id, domain, service, data? }
 *   GET  /iot/roomba/status?id=          Roomba state via HA
 *   POST /iot/roomba/start               start cleaning  { id, rooms? }
 *   POST /iot/roomba/stop                stop/dock  { id }
 *   POST /iot/roomba/avoid-occupied      avoid rooms with people in them  { id }
 */
import * as http  from 'http';
import * as https from 'https';
import * as fs    from 'fs';
import * as np    from 'path';
import * as os    from 'os';
import { exec }   from 'child_process';
import { RouteContext, RouteModule, IoTDevice, IoTDeviceType } from '../types';
import { send } from '../helpers';
import { getOccupiedRooms } from './presence';  // presence integration
import { encryptSecret, decryptSecret } from '../crypto';

// ─── Device registry persistence ─────────────────────────────────────────────

const REGISTRY_PATH = np.join(os.homedir(), '.agent-bridge', 'iot-devices.json');

function loadDevices(): IoTDevice[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) as IoTDevice[];
  } catch {
    return [];
  }
}

function saveDevices(devices: IoTDevice[]) {
  try {
    const dir = np.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Encrypt credentials before writing to disk
    const secured = devices.map(encryptDeviceCreds);
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(secured, null, 2), 'utf-8');
  } catch {}
}

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function uniqueId(devices: IoTDevice[], name: string) {
  const base = slugify(name);
  if (!devices.find(d => d.id === base)) return base;
  let n = 2;
  while (devices.find(d => d.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function redact(d: IoTDevice): IoTDevice & { token: string; password: string } {
  return { ...d, token: d.token ? '***' : '', password: d.password ? '***' : '' };
}

// ─── Credential helpers (encrypt at rest) ─────────────────────────────────────

function credLabel(deviceId: string, field: 'token' | 'password') {
  return `iot-${deviceId}-${field}`;
}

/** Return plaintext token for a device (decrypts if stored encrypted). */
function getDeviceToken(dev: IoTDevice): string {
  if (!dev.token) return '';
  try { return decryptSecret(dev.token, credLabel(dev.id, 'token')); } catch { return dev.token; }
}

/** Return plaintext password for a device. */
function getDevicePassword(dev: IoTDevice): string {
  if (!dev.password) return '';
  try { return decryptSecret(dev.password, credLabel(dev.id, 'password')); } catch { return dev.password ?? ''; }
}

/** Encrypt creds before persisting. Returns mutated copy. */
function encryptDeviceCreds(dev: IoTDevice): IoTDevice {
  const out = { ...dev };
  // Only encrypt if not already encrypted (prefix check)
  if (out.token && !out.token.startsWith('dpapi:') && !out.token.startsWith('keychain:') && !out.token.startsWith('xor:')) {
    try { out.token = encryptSecret(out.token, credLabel(out.id, 'token')); } catch {}
  }
  if (out.password && !out.password.startsWith('dpapi:') && !out.password.startsWith('keychain:') && !out.password.startsWith('xor:')) {
    try { out.password = encryptSecret(out.password, credLabel(out.id, 'password')); } catch {}
  }
  return out;
}

// ─── Generic HTTP helper ──────────────────────────────────────────────────────

interface ReqOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

function httpReq(url: string, opts: ReqOpts = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const options: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port) : (isHttps ? 443 : 80),
      path: u.pathname + (u.search ?? ''),
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(opts.headers ?? {}),
        ...(opts.body ? { 'Content-Length': Buffer.byteLength(opts.body) } : {}),
      },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.setTimeout(opts.timeoutMs ?? 8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─── Device-type-specific helpers ────────────────────────────────────────────

/** ── Home Assistant ── */
async function haGet(dev: IoTDevice, path: string) {
  const base = `http://${dev.host}:${dev.port ?? 8123}`;
  const r = await httpReq(`${base}${path}`, {
    headers: { 'Authorization': `Bearer ${getDeviceToken(dev)}` },
  });
  return JSON.parse(r.body);
}

async function haPost(dev: IoTDevice, path: string, data: unknown) {
  const base = `http://${dev.host}:${dev.port ?? 8123}`;
  const r = await httpReq(`${base}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getDeviceToken(dev)}` },
    body: JSON.stringify(data),
  });
  return JSON.parse(r.body);
}

async function haStatus(dev: IoTDevice): Promise<unknown> {
  const entity = String(dev.meta?.entity_id ?? '');
  if (entity) return haGet(dev, `/api/states/${entity}`);
  const all = await haGet(dev, '/api/states');
  return Array.isArray(all) ? { count: all.length, entities: all.slice(0, 50) } : all;
}

async function haControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const entity = String(params.entity_id ?? dev.meta?.entity_id ?? '');
  const [domain, service] = action.split('.');
  if (!domain || !service) throw new Error(`action must be "domain.service" e.g. "light.turn_on"`);
  return haPost(dev, `/api/services/${domain}/${service}`, { entity_id: entity, ...params });
}

/** ── Philips Hue ── */
async function hueBase(dev: IoTDevice) {
  return `http://${dev.host}/api/${dev.meta?.username ?? getDeviceToken(dev)}`;
}

async function hueStatus(dev: IoTDevice): Promise<unknown> {
  const r = await httpReq(`${await hueBase(dev)}/lights`);
  return JSON.parse(r.body);
}

async function hueControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const lightId = String(params.light_id ?? dev.meta?.light_id ?? '1');
  const state: Record<string, unknown> = {};
  if (action === 'turn_on')  { state.on = true;  if (params.brightness) state.bri = params.brightness; if (params.color_temp) state.ct = params.color_temp; }
  if (action === 'turn_off') { state.on = false; }
  if (action === 'bri')      { state.bri = Number(params.value ?? 128); }
  if (action === 'color')    { state.hue = params.hue; state.sat = params.sat; }
  if (action === 'set')      { Object.assign(state, params); delete state.light_id; }
  const r = await httpReq(`${await hueBase(dev)}/lights/${lightId}/state`, {
    method: 'PUT', body: JSON.stringify(state),
  });
  return JSON.parse(r.body);
}

/** ── Shelly ── */
async function shellyStatus(dev: IoTDevice): Promise<unknown> {
  const r = await httpReq(`http://${dev.host}:${dev.port ?? 80}/status`);
  return JSON.parse(r.body);
}

async function shellyControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const channel = String(params.channel ?? dev.meta?.channel ?? '0');
  let cmd = '';
  if (action === 'turn_on')  cmd = `http://${dev.host}/relay/${channel}?turn=on`;
  if (action === 'turn_off') cmd = `http://${dev.host}/relay/${channel}?turn=off`;
  if (action === 'toggle')   cmd = `http://${dev.host}/relay/${channel}?turn=toggle`;
  if (action === 'roller')   cmd = `http://${dev.host}/roller/0?go=${params.direction ?? 'open'}&duration=${params.duration ?? 0}`;
  if (!cmd) throw new Error(`Unknown Shelly action: ${action}`);
  const r = await httpReq(cmd);
  return JSON.parse(r.body);
}

/** ── Tasmota ── */
async function tasmotaStatus(dev: IoTDevice): Promise<unknown> {
  const r = await httpReq(`http://${dev.host}:${dev.port ?? 80}/cm?cmnd=Status%200`);
  return JSON.parse(r.body);
}

async function tasmotaControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const channel = String(params.channel ?? dev.meta?.channel ?? '');
  const suffix = channel ? `%20${channel}` : '';
  const cmds: Record<string, string> = {
    turn_on:  `Power${suffix}%20ON`,
    turn_off: `Power${suffix}%20OFF`,
    toggle:   `Power${suffix}%20TOGGLE`,
    blink:    `Power${suffix}%20BLINK`,
    dim:      `Dimmer%20${params.value ?? 50}`,
    color:    `Color%20${params.value ?? '#ff0000'}`,
  };
  const cmnd = cmds[action];
  if (!cmnd) throw new Error(`Unknown Tasmota action: ${action}`);
  const r = await httpReq(`http://${dev.host}/cm?cmnd=${cmnd}`);
  return JSON.parse(r.body);
}

/** ── WLED ── */
async function wledStatus(dev: IoTDevice): Promise<unknown> {
  const r = await httpReq(`http://${dev.host}:${dev.port ?? 80}/json/state`);
  return JSON.parse(r.body);
}

async function wledControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const state: Record<string, unknown> = {};
  if (action === 'turn_on')  state.on = true;
  if (action === 'turn_off') state.on = false;
  if (action === 'toggle')   state.on = 'toggle';
  if (action === 'brightness') state.bri = Number(params.value ?? 128);
  if (action === 'preset')   state.ps = Number(params.id ?? 1);
  if (action === 'effect')   state.seg = [{ fx: Number(params.id ?? 0) }];
  if (action === 'color')    state.seg = [{ col: [[Number(params.r ?? 255), Number(params.g ?? 255), Number(params.b ?? 255)]] }];
  if (action === 'set')      Object.assign(state, params);
  const r = await httpReq(`http://${dev.host}:${dev.port ?? 80}/json/state`, {
    method: 'POST', body: JSON.stringify(state),
  });
  return JSON.parse(r.body);
}

/** ── ESPHome ── */
async function esphomeStatus(dev: IoTDevice): Promise<unknown> {
  const r = await httpReq(`http://${dev.host}:${dev.port ?? 6052}/`);
  return { online: r.status === 200, raw: r.body.slice(0, 500) };
}

async function esphomeControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  // ESPHome REST API: GET /switch/<id>/turn_on|off, /light/<id>/turn_on?brightness=...
  const component = String(params.component ?? dev.meta?.component ?? 'switch');
  const entityId  = String(params.entity_id ?? dev.meta?.entity_id ?? 'relay');
  let path = `/${component}/${entityId}/${action}`;
  const qp = Object.entries(params)
    .filter(([k]) => !['component', 'entity_id'].includes(k))
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  if (qp) path += '?' + qp;
  const r = await httpReq(`http://${dev.host}:${dev.port ?? 6052}${path}`);
  return JSON.parse(r.body);
}

/** ── Tuya cloud (simple REST) ── */
async function tuyaControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  // Tuya requires HMAC-SHA256 signing — we wrap their OpenAPI v2.0
  // For simplicity we call their plain REST with a pre-obtained access token
  const region    = String(dev.meta?.region ?? 'us');
  const deviceId  = String(dev.meta?.device_id ?? '');
  const clientId  = String(dev.meta?.client_id ?? '');
  const accessToken = dev.token ?? '';
  const base = `https://openapi.tuya${region}.com`;

  const commands: Record<string, unknown>[] = [];
  if (action === 'turn_on')  commands.push({ code: 'switch_led', value: true });
  if (action === 'turn_off') commands.push({ code: 'switch_led', value: false });
  if (action === 'set')      commands.push(...Object.entries(params).map(([code, value]) => ({ code, value })));
  if (!commands.length) throw new Error(`Unknown Tuya action: ${action}`);

  const r = await httpReq(`${base}/v1.0/devices/${deviceId}/commands`, {
    method: 'POST',
    headers: {
      'client_id': clientId,
      'access_token': accessToken,
      'sign_method': 'HMAC-SHA256',
      't': String(Date.now()),
    },
    body: JSON.stringify({ commands }),
  });
  return JSON.parse(r.body);
}

/** ── Generic REST ── */
async function restControl(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const endpoint = String(dev.meta?.endpoints?.[action as keyof typeof dev.meta.endpoints] ?? params.path ?? '/');
  const method   = String(params.method ?? 'GET');
  const url = endpoint.startsWith('http') ? endpoint : `http://${dev.host}:${dev.port ?? 80}${endpoint}`;
  const headers: Record<string, string> = {};
  if (dev.token) headers['Authorization'] = `Bearer ${dev.token}`;
  if (dev.username && dev.password) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${dev.username}:${dev.password}`).toString('base64');
  }
  const r = await httpReq(url, { method, headers, body: method !== 'GET' ? JSON.stringify(params) : undefined });
  try { return JSON.parse(r.body); } catch { return { status: r.status, body: r.body }; }
}

/** ── MQTT (via mosquitto_pub CLI — must be installed on host) ── */
async function mqttPublish(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  const broker  = `mqtt://${dev.host}:${dev.port ?? 1883}`;
  const topic   = String(params.topic ?? dev.meta?.topic ?? 'home/device');
  const payload = params.payload ? JSON.stringify(params.payload) : action;
  const auth    = dev.username ? `-u ${dev.username} -P ${dev.password ?? ''}` : '';
  const cmd     = `mosquitto_pub -h ${dev.host} -p ${dev.port ?? 1883} ${auth} -t "${topic}" -m '${payload.replace(/'/g, '')}'`;
  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr, broker, topic, payload });
    });
  });
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

async function getStatus(dev: IoTDevice): Promise<unknown> {
  switch (dev.type) {
    case 'homeassistant': return haStatus(dev);
    case 'roomba':        return haStatus(dev);   // Roomba registered as HA device
    case 'hue':           return hueStatus(dev);
    case 'shelly':        return shellyStatus(dev);
    case 'tasmota':       return tasmotaStatus(dev);
    case 'wled':          return wledStatus(dev);
    case 'esphome':       return esphomeStatus(dev);
    case 'rest':          return restControl(dev, 'GET', {});
    case 'tuya':          return { ok: true, note: 'Tuya status polling not implemented — use iot/control' };
    case 'mqtt':          return { ok: true, note: 'MQTT is fire-and-forget — use iot/control to publish' };
    default:              return { ok: false, error: `Unknown device type: ${dev.type}` };
  }
}

async function controlDevice(dev: IoTDevice, action: string, params: Record<string, unknown>): Promise<unknown> {
  switch (dev.type) {
    case 'homeassistant': return haControl(dev, action, params);
    case 'roomba':        return haControl(dev, action, params);
    case 'hue':           return hueControl(dev, action, params);
    case 'shelly':        return shellyControl(dev, action, params);
    case 'tasmota':       return tasmotaControl(dev, action, params);
    case 'wled':          return wledControl(dev, action, params);
    case 'esphome':       return esphomeControl(dev, action, params);
    case 'tuya':          return tuyaControl(dev, action, params);
    case 'mqtt':          return mqttPublish(dev, action, params);
    case 'rest':
    default:              return restControl(dev, action, params);
  }
}

// ─── Natural language command router ─────────────────────────────────────────
// Lets Slack/AI agents say "turn off the living room lights" without knowing API details

const NL_PATTERNS: Array<{ re: RegExp; action: string; params?: Record<string, unknown> }> = [
  { re: /\bturn\s+on\b/i,       action: 'turn_on' },
  { re: /\bturn\s+off\b/i,      action: 'turn_off' },
  { re: /\btoggle\b/i,          action: 'toggle' },
  { re: /\bstart\b.*\bclean/i,  action: 'vacuum.start' },
  { re: /\bstop\b.*\bclean/i,   action: 'vacuum.stop' },
  { re: /\bdock\b|\breturn\b.*\bbase/i, action: 'vacuum.return_to_base' },
  { re: /\bpause\b/i,           action: 'vacuum.pause' },
  { re: /\bdim\b.*?(\d+)/i,     action: 'bri' },
  { re: /\bbright\b.*?(\d+)/i,  action: 'bri' },
  { re: /\bset\b.*?(\d+)%/i,    action: 'bri' },
  { re: /\bwhite\b/i,           action: 'turn_on', params: { color_temp: 4000 } },
  { re: /\bred\b/i,             action: 'color',   params: { r: 255, g: 0,   b: 0 } },
  { re: /\bblue\b/i,            action: 'color',   params: { r: 0,   g: 0,   b: 255 } },
  { re: /\bgreen\b/i,           action: 'color',   params: { r: 0,   g: 255, b: 0 } },
  { re: /\bopen\b/i,            action: 'open' },
  { re: /\bclose\b/i,           action: 'close' },
  { re: /\block\b/i,            action: 'lock' },
  { re: /\bunlock\b/i,          action: 'unlock' },
];

function parseNLCommand(text: string): { action: string; params: Record<string, unknown> } {
  for (const p of NL_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const extraParams: Record<string, unknown> = {};
      // extract numeric value if group captured
      if (m[1]) extraParams.value = parseInt(m[1], 10);
      return { action: p.action, params: { ...p.params, ...extraParams } };
    }
  }
  return { action: text.trim().toLowerCase().replace(/\s+/g, '_'), params: {} };
}

// ─── Discovery helpers ────────────────────────────────────────────────────────
// Quick LAN scan by probing default ports of known device types

interface DiscoveredDevice { host: string; type: IoTDeviceType; details: unknown }

async function probeHost(ip: string, port: number, path: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const r = await httpReq(`http://${ip}:${port}${path}`, { timeoutMs });
    return r.body;
  } catch {
    return null;
  }
}

async function discoverLAN(subnet: string): Promise<DiscoveredDevice[]> {
  const found: DiscoveredDevice[] = [];
  const parts = subnet.split('.');
  const base = parts.slice(0, 3).join('.');

  const checks: Array<Promise<void>> = [];

  for (let i = 1; i <= 254; i++) {
    const ip = `${base}.${i}`;

    // Shelly: /status on port 80
    checks.push(probeHost(ip, 80, '/shelly', 1200).then(b => {
      if (b && b.includes('fw')) found.push({ host: ip, type: 'shelly', details: JSON.parse(b) });
    }).catch(() => {}));

    // Tasmota: /cm?cmnd=Status on port 80
    checks.push(probeHost(ip, 80, '/cm?cmnd=Status', 1200).then(b => {
      if (b && b.toLowerCase().includes('tasmota')) found.push({ host: ip, type: 'tasmota', details: JSON.parse(b) });
    }).catch(() => {}));

    // WLED: /json/info on port 80
    checks.push(probeHost(ip, 80, '/json/info', 1200).then(b => {
      if (b && b.includes('wled')) found.push({ host: ip, type: 'wled', details: JSON.parse(b) });
    }).catch(() => {}));

    // ESPHome: port 6052
    checks.push(probeHost(ip, 6052, '/', 1200).then(b => {
      if (b) found.push({ host: ip, type: 'esphome', details: { online: true } });
    }).catch(() => {}));

    // Home Assistant: port 8123
    checks.push(probeHost(ip, 8123, '/api/', 2000).then(b => {
      if (b && b.includes('API')) found.push({ host: ip, type: 'homeassistant', details: JSON.parse(b || '{}') });
    }).catch(() => {}));
  }

  await Promise.allSettled(checks);
  return found;
}

// ─── Roomba helpers ───────────────────────────────────────────────────────────

async function roombaStart(dev: IoTDevice, rooms?: string[]): Promise<unknown> {
  const entity = String(dev.meta?.entity_id ?? 'vacuum.roomba');

  if (rooms && rooms.length > 0) {
    // Home Assistant vacuum "send_command" with room list
    const roomIds = rooms.map(r => String(dev.meta?.rooms?.[r as keyof typeof dev.meta.rooms] ?? r));
    return haPost(dev, '/api/services/vacuum/send_command', {
      entity_id: entity,
      command: 'set_fan_speed',  // placeholder — actual HA sends clean_spot or zone_clean
      params: { rooms: roomIds },
    });
  }

  return haPost(dev, '/api/services/vacuum/start', { entity_id: entity });
}

async function roombaAvoidOccupied(dev: IoTDevice): Promise<unknown> {
  const occupied = getOccupiedRooms();
  const allRooms  = Object.keys(dev.meta?.rooms ?? {}) as string[];
  const cleanRooms = allRooms.filter(r => !occupied.includes(r.toLowerCase()));

  if (cleanRooms.length === 0) {
    return { ok: false, note: 'All configured rooms are occupied — Roomba will stay docked', occupied };
  }

  if (cleanRooms.length === allRooms.length) {
    // No one home — clean everything
    const result = await roombaStart(dev);
    return { ok: true, mode: 'full_clean', occupied: [], result };
  }

  const result = await roombaStart(dev, cleanRooms);
  return { ok: true, mode: 'partial_clean', cleaning: cleanRooms, avoiding: occupied, result };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const iotRoutes: RouteModule = async (ctx: RouteContext): Promise<boolean> => {
  const { meth, pathStr, qp, b, res } = ctx;

  if (!pathStr.startsWith('/iot')) return false;

  // ── GET /iot/devices ─────────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/iot/devices') {
    const devices = loadDevices();
    send(res, 200, { ok: true, count: devices.length, devices: devices.map(redact) });
    return true;
  }

  // ── POST /iot/devices ────────────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/devices') {
    const name = String(b.name ?? '').trim();
    const type = String(b.type ?? 'rest') as IoTDeviceType;
    const host = String(b.host ?? '').trim();
    if (!name || !host) { send(res, 400, { ok: false, error: 'name and host are required' }); return true; }

    const devices = loadDevices();
    const device: IoTDevice = {
      id:       String(b.id ?? uniqueId(devices, name)),
      name,
      type,
      host,
      port:     b.port ? Number(b.port) : undefined,
      token:    b.token ? String(b.token) : undefined,
      username: b.username ? String(b.username) : undefined,
      password: b.password ? String(b.password) : undefined,
      meta:     b.meta as Record<string, unknown> | undefined,
      added:    Date.now(),
    };
    devices.push(device);
    saveDevices(devices);
    send(res, 200, { ok: true, device: redact(device) });
    return true;
  }

  // ── PUT /iot/devices ─────────────────────────────────────────────────────
  if (meth === 'PUT' && pathStr === '/iot/devices') {
    const id = String(b.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const devices = loadDevices();
    const idx = devices.findIndex(d => d.id === id);
    if (idx < 0) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    const updated = { ...devices[idx], ...b, id } as IoTDevice;
    devices[idx] = updated;
    saveDevices(devices);
    send(res, 200, { ok: true, device: redact(updated) });
    return true;
  }

  // ── DELETE /iot/devices ──────────────────────────────────────────────────
  if (meth === 'DELETE' && pathStr === '/iot/devices') {
    const id = String(qp.id ?? b.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    let devices = loadDevices();
    const before = devices.length;
    devices = devices.filter(d => d.id !== id);
    if (devices.length === before) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    saveDevices(devices);
    send(res, 200, { ok: true, removed: id });
    return true;
  }

  // ── GET /iot/status ──────────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/iot/status') {
    const id = String(qp.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const state = await getStatus(dev);
      send(res, 200, { ok: true, id, name: dev.name, type: dev.type, state });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── GET /iot/status-all ──────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/iot/status-all') {
    const devices = loadDevices();
    const results = await Promise.allSettled(devices.map(d =>
      getStatus(d).then(state => ({ id: d.id, name: d.name, type: d.type, state, ok: true }))
    ));
    const items = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { id: devices[i].id, name: devices[i].name, ok: false, error: String((r as PromiseRejectedResult).reason) }
    );
    send(res, 200, { ok: true, count: items.length, devices: items });
    return true;
  }

  // ── POST /iot/control ────────────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/control') {
    const id     = String(b.id ?? '').trim();
    const action = String(b.action ?? '').trim();
    const params = (b.params as Record<string, unknown>) ?? {};
    if (!id || !action) { send(res, 400, { ok: false, error: 'id and action are required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const result = await controlDevice(dev, action, params);
      send(res, 200, { ok: true, id, action, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── POST /iot/command  (natural language) ────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/command') {
    const text     = String(b.text ?? b.command ?? '').trim();
    const deviceId = String(b.device_id ?? '').trim();
    if (!text) { send(res, 400, { ok: false, error: 'text required' }); return true; }

    const devices = loadDevices();
    const targets = deviceId
      ? devices.filter(d => d.id === deviceId || d.name.toLowerCase().includes(deviceId.toLowerCase()))
      : devices;

    if (!targets.length) { send(res, 404, { ok: false, error: 'No matching devices found' }); return true; }

    // Also try to match device name in the text
    const namedTargets = targets.filter(d => text.toLowerCase().includes(d.name.toLowerCase()));
    const finalTargets = namedTargets.length > 0 ? namedTargets : targets.slice(0, 1);

    const { action, params } = parseNLCommand(text);

    const results = await Promise.allSettled(
      finalTargets.map(d => controlDevice(d, action, params).then(r => ({ id: d.id, name: d.name, result: r })))
    );
    const items = results.map((r, i) =>
      r.status === 'fulfilled' ? { ...r.value, ok: true }
        : { id: finalTargets[i].id, name: finalTargets[i].name, ok: false, error: String((r as PromiseRejectedResult).reason) }
    );
    send(res, 200, { ok: true, parsed_action: action, params, targeted: items });
    return true;
  }

  // ── GET /iot/discover ────────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/iot/discover') {
    const subnet = String(qp.subnet ?? '192.168.1.1');
    const alreadyKnown = loadDevices().map(d => d.host);
    try {
      const found = await discoverLAN(subnet);
      const newDevices = found.filter(f => !alreadyKnown.includes(f.host));
      send(res, 200, {
        ok: true,
        subnet,
        found: found.length,
        new_devices: newDevices,
        all: found,
        note: 'To register a discovered device, POST to /iot/devices with the host and type.',
      });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── GET /iot/ha/entities ─────────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/iot/ha/entities') {
    const id = String(qp.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev || dev.type !== 'homeassistant') {
      send(res, 404, { ok: false, error: 'Home Assistant device not found' }); return true;
    }
    try {
      const filter = qp.filter ?? '';
      const all: Array<{ entity_id: string; state: string; attributes: unknown }> = await haGet(dev, '/api/states');
      const items = filter ? all.filter(e => e.entity_id.includes(filter) || String(e.state).includes(filter)) : all;
      send(res, 200, { ok: true, count: items.length, entities: items.slice(0, 200) });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── POST /iot/ha/service ─────────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/ha/service') {
    const id      = String(b.id ?? '').trim();
    const domain  = String(b.domain ?? '').trim();
    const service = String(b.service ?? '').trim();
    const data    = (b.data as Record<string, unknown>) ?? {};
    if (!id || !domain || !service) {
      send(res, 400, { ok: false, error: 'id, domain, service required' }); return true;
    }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const result = await haPost(dev, `/api/services/${domain}/${service}`, data);
      send(res, 200, { ok: true, result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── GET /iot/roomba/status ───────────────────────────────────────────────
  if (meth === 'GET' && pathStr === '/iot/roomba/status') {
    const id = String(qp.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const state = await getStatus(dev);
      send(res, 200, { ok: true, state });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── POST /iot/roomba/start ───────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/roomba/start') {
    const id    = String(b.id ?? '').trim();
    const rooms = Array.isArray(b.rooms) ? (b.rooms as string[]) : undefined;
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const result = await roombaStart(dev, rooms);
      send(res, 200, { ok: true, rooms: rooms ?? 'all', result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── POST /iot/roomba/stop ────────────────────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/roomba/stop') {
    const id = String(b.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const entity = String(dev.meta?.entity_id ?? 'vacuum.roomba');
      const result = await haPost(dev, '/api/services/vacuum/return_to_base', { entity_id: entity });
      send(res, 200, { ok: true, action: 'return_to_base', result });
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  // ── POST /iot/roomba/avoid-occupied ─────────────────────────────────────
  if (meth === 'POST' && pathStr === '/iot/roomba/avoid-occupied') {
    const id = String(b.id ?? '').trim();
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    const dev = loadDevices().find(d => d.id === id);
    if (!dev) { send(res, 404, { ok: false, error: `Device not found: ${id}` }); return true; }
    try {
      const result = await roombaAvoidOccupied(dev);
      send(res, 200, result as object);
    } catch (e) { send(res, 500, { ok: false, error: String(e) }); }
    return true;
  }

  return false;
};
