/**
 * src/routes/security.ts
 *
 * Security engine for Agent Bridge:
 *   - Per-device risk scoring (0-100)
 *   - Per-IP and per-device rate limiting / brute-force blocking
 *   - Security event log
 *   - AI-powered threat analysis (DeepSeek / OpenAI)
 *   - Auto-remediation hints
 *
 * Endpoints:
 *   GET  /security/score            overall + per-device risk profiles
 *   GET  /security/device/:id       detailed profile for one device
 *   GET  /security/events           security event log (last N)
 *   GET  /security/rate-limits      currently blocked / throttled IPs
 *   POST /security/scan             retrigger full risk scan
 *   POST /security/analyze          AI analysis of current posture
 *   POST /security/remediate/:id    apply recommended fix to one device
 *   DELETE /security/events         clear event log
 */

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as http from 'http';
import { RouteContext, RouteModule, IoTDevice, IoTDeviceType } from '../types';
import { send } from '../helpers';

// ─── Persistence paths ────────────────────────────────────────────────────────

const DATA_DIR    = path.join(os.homedir(), '.agent-bridge');
const EVENTS_FILE = path.join(DATA_DIR, 'security-events.json');
const DEVICES_FILE = path.join(DATA_DIR, 'iot-devices.json');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SecurityEvent {
  id:        string;
  ts:        number;          // Unix ms
  type:      'auth_fail' | 'rate_limit' | 'anomaly' | 'brute_force'
           | 'device_risk_change' | 'scan' | 'remediation' | 'ai_alert';
  severity:  'low' | 'medium' | 'high' | 'critical';
  ip?:       string;
  deviceId?: string;
  message:   string;
  details?:  Record<string, unknown>;
}

export interface RiskFactor {
  name:    string;
  score:   number;   // contribution to total (0-100 scale, will be weighted)
  detail:  string;
}

export interface DeviceRiskProfile {
  deviceId:    string;
  deviceName:  string;
  deviceType:  IoTDeviceType;
  riskScore:   number;           // 0-100
  riskLevel:   'low' | 'medium' | 'high' | 'critical';
  factors:     RiskFactor[];
  lastScanned: number;
  recommendations: string[];
}

interface RateLimitEntry {
  ip:          string;
  requests:    number[];    // timestamps of recent requests
  authFails:   number[];    // timestamps of recent auth failures
  blocked:     boolean;
  blockedUntil: number;
}

// ─── In-memory state ──────────────────────────────────────────────────────────

const rateLimits = new Map<string, RateLimitEntry>();
let eventBuffer: SecurityEvent[] = [];
let deviceProfiles: Map<string, DeviceRiskProfile> = new Map();

const RATE_WINDOW_MS      = 60_000;   // 1 minute sliding window
const RATE_MAX_REQUESTS   = 120;      // max requests per IP per minute
const AUTH_FAIL_THRESHOLD = 5;        // block after 5 auth failures
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;    // within 5 minutes
const BLOCK_DURATION_MS   = 15 * 60_000;   // block for 15 minutes
const MAX_EVENTS          = 2_000;

// ─── Event persistence ────────────────────────────────────────────────────────

function loadEvents(): SecurityEvent[] {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const arr = JSON.parse(raw) as SecurityEvent[];
    return Array.isArray(arr) ? arr.slice(-MAX_EVENTS) : [];
  } catch { return []; }
}

function saveEvents() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(eventBuffer.slice(-MAX_EVENTS), null, 2), 'utf-8');
  } catch {}
}

eventBuffer = loadEvents();

export function logSecurityEvent(event: Omit<SecurityEvent, 'id' | 'ts'>) {
  const ev: SecurityEvent = {
    id: Math.random().toString(36).slice(2),
    ts: Date.now(),
    ...event,
  };
  eventBuffer.push(ev);
  if (eventBuffer.length > MAX_EVENTS) eventBuffer = eventBuffer.slice(-MAX_EVENTS);
  // persist every 10th event to avoid hammering disk
  if (eventBuffer.length % 10 === 0) saveEvents();
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

function getEntry(ip: string): RateLimitEntry {
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { ip, requests: [], authFails: [], blocked: false, blockedUntil: 0 });
  }
  return rateLimits.get(ip)!;
}

/**
 * Call this on EVERY inbound request. Returns true if the request is ALLOWED,
 * false if it should be blocked (caller sends 429).
 */
export function checkRateLimit(ip: string): boolean {
  const now = ip === '127.0.0.1' || ip === '::1' ? -1 : Date.now(); // never block loopback
  if (now === -1) return true;

  const e = getEntry(ip);

  // Check block status
  if (e.blocked && now < e.blockedUntil) return false;
  if (e.blocked && now >= e.blockedUntil) {
    // Unblock
    e.blocked = false;
    e.authFails = [];
  }

  // Sliding-window request count
  e.requests = e.requests.filter(t => now - t < RATE_WINDOW_MS);
  e.requests.push(now);

  if (e.requests.length > RATE_MAX_REQUESTS) {
    e.blocked = true;
    e.blockedUntil = now + BLOCK_DURATION_MS;
    logSecurityEvent({
      type:     'rate_limit',
      severity: 'medium',
      ip,
      message:  `Rate limit exceeded: ${e.requests.length} requests/min from ${ip}. Blocked for 15 min.`,
    });
    return false;
  }
  return true;
}

/**
 * Call whenever an Authorization header is rejected. After AUTH_FAIL_THRESHOLD
 * failures in AUTH_FAIL_WINDOW_MS the IP is flagged as brute-force.
 */
export function recordAuthFailure(ip: string) {
  if (ip === '127.0.0.1' || ip === '::1') return;
  const now = Date.now();
  const e = getEntry(ip);
  e.authFails = e.authFails.filter(t => now - t < AUTH_FAIL_WINDOW_MS);
  e.authFails.push(now);

  if (e.authFails.length >= AUTH_FAIL_THRESHOLD) {
    e.blocked     = true;
    e.blockedUntil = now + BLOCK_DURATION_MS;
    logSecurityEvent({
      type:     'brute_force',
      severity: 'high',
      ip,
      message:  `Brute-force detected: ${e.authFails.length} auth failures in 5 min from ${ip}. Blocked for 15 min.`,
    });
  } else {
    logSecurityEvent({
      type:     'auth_fail',
      severity: e.authFails.length >= 3 ? 'medium' : 'low',
      ip,
      message:  `Auth failure #${e.authFails.length} from ${ip}`,
    });
  }
}

// ─── Risk scorer ──────────────────────────────────────────────────────────────

/** Base risk contribution by device type (0-100). */
const BASE_RISK: Record<IoTDeviceType, number> = {
  homeassistant: 40,  // central hub — high value target
  mqtt:          38,  // broker — often exposed on network
  tuya:          35,  // cloud-dependent, data leaves home
  rest:          30,  // generic, unknown surface
  roomba:        22,  // maps your home, less direct
  hue:           18,  // local only, well-maintained
  shelly:        15,  // local HTTP, low complexity
  tasmota:       14,  // local HTTP, open firmware
  esphome:       14,  // local HTTP, open firmware
  wled:          10,  // LED control only
};

const CRED_PREFIXES = ['dpapi:', 'keychain:', 'xor:'];
function isEncrypted(s?: string): boolean {
  return !s || CRED_PREFIXES.some(p => s.startsWith(p));
}

function isCloudHost(host: string): boolean {
  const local = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return !local;
}

export function scoreDevice(device: IoTDevice, authFailsLast24h = 0): DeviceRiskProfile {
  const factors: RiskFactor[] = [];
  let score = BASE_RISK[device.type] ?? 25;

  factors.push({
    name:   'Device type exposure',
    score:  BASE_RISK[device.type] ?? 25,
    detail: `${device.type} devices have a base risk of ${BASE_RISK[device.type] ?? 25}/100`,
  });

  // Unencrypted credentials
  const tokenBad    = device.token    && !isEncrypted(device.token);
  const passwordBad = device.password && !isEncrypted(device.password);
  if (tokenBad || passwordBad) {
    const add = 25;
    score += add;
    factors.push({
      name:   'Credentials stored plaintext',
      score:  add,
      detail: `Token or password is stored in plaintext — run a security scan to encrypt.`,
    });
  }

  // Cloud-hosted device
  if (isCloudHost(device.host)) {
    const add = 12;
    score += add;
    factors.push({
      name:   'Cloud-hosted device',
      score:  add,
      detail: `Host "${device.host}" resolves to a non-LAN address — traffic leaves your network.`,
    });
  }

  // No credentials configured at all (public API)
  if (!device.token && !device.password) {
    const add = 8;
    score += add;
    factors.push({
      name:   'No authentication configured',
      score:  add,
      detail: `Device has no token or password — anyone who can reach it can control it.`,
    });
  }

  // Auth failures in last 24h
  if (authFailsLast24h > 0) {
    const add = Math.min(authFailsLast24h * 5, 30);
    score += add;
    factors.push({
      name:   'Recent auth failures',
      score:  add,
      detail: `${authFailsLast24h} failed auth attempts targeting this device in the last 24h.`,
    });
  }

  // Device age — old devices may have stale firmware
  const ageMs   = Date.now() - device.added;
  const ageMonths = ageMs / (30 * 24 * 3600 * 1000);
  if (ageMonths > 12) {
    const add = Math.min(Math.floor(ageMonths / 6), 15);
    score += add;
    factors.push({
      name:   'Stale device record',
      score:  add,
      detail: `Device registered ${Math.floor(ageMonths)} months ago — verify firmware is current.`,
    });
  }

  // HTTP on a non-local host (should be HTTPS)
  if (isCloudHost(device.host) && !device.host.startsWith('https://')) {
    const add = 10;
    score += add;
    factors.push({
      name:   'Unencrypted transport to cloud',
      score:  add,
      detail: `Cloud-hosted devices should use HTTPS. Consider updating the host URL.`,
    });
  }

  score = Math.min(Math.round(score), 100);

  const riskLevel = score >= 75 ? 'critical'
                  : score >= 50 ? 'high'
                  : score >= 25 ? 'medium'
                  : 'low';

  const recommendations: string[] = [];
  if (tokenBad || passwordBad) recommendations.push('Encrypt credentials: POST /security/remediate/' + device.id);
  if (!device.token && !device.password) recommendations.push('Add authentication: PUT /iot/devices  { id, token: "..." }');
  if (authFailsLast24h >= 3) recommendations.push('Investigate auth failures — possible brute-force in progress');
  if (isCloudHost(device.host) && !device.host.startsWith('https://')) recommendations.push('Update host to use https://');
  if (ageMonths > 12) recommendations.push('Review device — confirm firmware is up to date');
  if (recommendations.length === 0) recommendations.push('No immediate actions required');

  return {
    deviceId:    device.id,
    deviceName:  device.name,
    deviceType:  device.type,
    riskScore:   score,
    riskLevel,
    factors,
    lastScanned: Date.now(),
    recommendations,
  };
}

export function getOverallScore(profiles: DeviceRiskProfile[]): number {
  if (profiles.length === 0) return 0;
  // Weighted average — critical devices count double
  let total = 0, weight = 0;
  for (const p of profiles) {
    const w = p.riskLevel === 'critical' ? 2 : 1;
    total  += p.riskScore * w;
    weight += w;
  }
  return Math.round(total / weight);
}

function loadDevices(): IoTDevice[] {
  try {
    const raw = fs.readFileSync(DEVICES_FILE, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) as IoTDevice[];
  } catch { return []; }
}

export function runSecurityScan(): DeviceRiskProfile[] {
  const devices = loadDevices();
  const now24h  = Date.now() - 24 * 3600 * 1000;

  // Count auth failures per device in last 24h from event log
  const failsByDevice = new Map<string, number>();
  for (const ev of eventBuffer) {
    if (ev.type === 'auth_fail' && ev.ts > now24h && ev.deviceId) {
      failsByDevice.set(ev.deviceId, (failsByDevice.get(ev.deviceId) ?? 0) + 1);
    }
  }

  const profiles = devices.map(d => scoreDevice(d, failsByDevice.get(d.id) ?? 0));

  // Log if any device moved to critical
  for (const p of profiles) {
    const prev = deviceProfiles.get(p.deviceId);
    if (prev && prev.riskLevel !== p.riskLevel && p.riskLevel === 'critical') {
      logSecurityEvent({
        type:     'device_risk_change',
        severity: 'high',
        deviceId: p.deviceId,
        message:  `Device "${p.deviceName}" risk level changed to CRITICAL (score ${p.riskScore})`,
      });
    }
    deviceProfiles.set(p.deviceId, p);
  }

  // Add scan event
  logSecurityEvent({
    type:     'scan',
    severity: 'low',
    message:  `Security scan completed: ${profiles.length} device(s) scored. Overall: ${getOverallScore(profiles)}/100`,
    details:  { deviceCount: profiles.length, overall: getOverallScore(profiles) },
  });

  return profiles;
}

// ─── AI threat analysis ───────────────────────────────────────────────────────

function callBridgeAI(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: prompt }] });
    const req  = http.request({
      hostname: '127.0.0.1',
      port:     parseInt(process.env.AGENT_BRIDGE_PORT ?? '3131', 10),
      path:     '/ai/chat',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${process.env.AGENT_BRIDGE_TOKEN ?? ''}`,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(j.content ?? j.choices?.[0]?.message?.content ?? d);
        } catch { resolve(d); }
      });
    });
    req.on('error', () => resolve('AI service unavailable — add a DeepSeek or OpenAI key via POST /ai/keys'));
    req.write(body);
    req.end();
  });
}

function buildAnalysisPrompt(profiles: DeviceRiskProfile[], recentEvents: SecurityEvent[]): string {
  const critical = profiles.filter(p => p.riskLevel === 'critical');
  const high     = profiles.filter(p => p.riskLevel === 'high');
  const overall  = getOverallScore(profiles);

  const deviceSummary = profiles
    .sort((a, b) => b.riskScore - a.riskScore)
    .map(p => `  - ${p.deviceName} (${p.deviceType}): score=${p.riskScore} [${p.riskLevel}] — ${p.factors.map(f => f.name).join(', ')}`)
    .join('\n');

  const eventSummary = recentEvents
    .slice(-20)
    .map(e => `  [${e.severity.toUpperCase()}] ${e.type}: ${e.message}`)
    .join('\n');

  return `You are a cybersecurity expert analyzing an IoT home automation network.

== Current Security Posture ==
Overall risk score: ${overall}/100
Critical devices: ${critical.length}
High-risk devices: ${high.length}
Total devices: ${profiles.length}

== Device Risk Breakdown (sorted by risk) ==
${deviceSummary || '  No devices registered yet.'}

== Recent Security Events (last 20) ==
${eventSummary || '  No events yet.'}

== Your Task ==
1. Identify the top 3 most urgent threats and why they are dangerous.
2. For each critical or high-risk device, give a specific actionable remediation step.
3. Identify any patterns in the security events that suggest an active threat actor.
4. Give an overall security grade (A-F) with justification.
5. List 3 proactive hardening steps for this specific device mix.

Keep your answer structured with headers. Be direct and specific — no generic advice.
Assume the operator is technically skilled but time-constrained.`;
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const securityRoutes: RouteModule = async (ctx) => {
  const { meth, pathStr, res } = ctx;
  const reply = (code: number, body: unknown) => { send(res, code, body); return true; };

  // GET /security/score
  if (meth === 'GET' && pathStr === '/security/score') {
    const profiles = runSecurityScan();
    return reply(200, {
      overall:  getOverallScore(profiles),
      devices:  profiles,
      eventCount: eventBuffer.length,
      blockedIPs: [...rateLimits.values()].filter(e => e.blocked).length,
    });
  }

  // GET /security/device/:id
  if (meth === 'GET' && pathStr.startsWith('/security/device/')) {
    const id      = pathStr.slice('/security/device/'.length);
    const devices = loadDevices();
    const device  = devices.find(d => d.id === id);
    if (!device) return reply(404, { error: 'Device not found' });
    const profile = scoreDevice(device);
    return reply(200, profile);
  }

  // GET /security/events
  if (meth === 'GET' && pathStr === '/security/events') {
    const limit = parseInt(ctx.qp.limit ?? '100', 10);
    return reply(200, { events: eventBuffer.slice(-limit).reverse(), total: eventBuffer.length });
  }

  // DELETE /security/events
  if (meth === 'DELETE' && pathStr === '/security/events') {
    eventBuffer = [];
    saveEvents();
    return reply(200, { cleared: true });
  }

  // GET /security/rate-limits
  if (meth === 'GET' && pathStr === '/security/rate-limits') {
    const now = Date.now();
    const entries = [...rateLimits.values()].map(e => ({
      ip:          e.ip,
      blocked:     e.blocked && now < e.blockedUntil,
      blockedUntil: e.blocked ? new Date(e.blockedUntil).toISOString() : null,
      requestsLastMin: e.requests.filter(t => now - t < RATE_WINDOW_MS).length,
      authFailsLast5m: e.authFails.filter(t => now - t < AUTH_FAIL_WINDOW_MS).length,
    }));
    return reply(200, { rateLimits: entries });
  }

  // POST /security/scan
  if (meth === 'POST' && pathStr === '/security/scan') {
    const profiles = runSecurityScan();
    return reply(200, {
      scanned:  profiles.length,
      overall:  getOverallScore(profiles),
      critical: profiles.filter(p => p.riskLevel === 'critical').length,
      high:     profiles.filter(p => p.riskLevel === 'high').length,
      profiles,
    });
  }

  // POST /security/analyze
  if (meth === 'POST' && pathStr === '/security/analyze') {
    const profiles = runSecurityScan();
    const prompt   = buildAnalysisPrompt(profiles, eventBuffer);
    const analysis = await callBridgeAI(prompt);
    logSecurityEvent({
      type:     'ai_alert',
      severity: 'low',
      message:  'AI security analysis requested',
      details:  { analysisLength: analysis.length },
    });
    return reply(200, {
      analysis,
      overall:  getOverallScore(profiles),
      profiles,
      ts:       new Date().toISOString(),
    });
  }

  // POST /security/remediate/:id
  if (meth === 'POST' && pathStr.startsWith('/security/remediate/')) {
    const id      = pathStr.slice('/security/remediate/'.length);
    const devices = loadDevices();
    const device  = devices.find(d => d.id === id);
    if (!device) return reply(404, { error: 'Device not found' });

    const actions: string[] = [];

    if (device.token && !isEncrypted(device.token)) {
      actions.push('Plaintext token detected — call PUT /iot/devices to re-save and encrypt.');
    }
    if (device.password && !isEncrypted(device.password)) {
      actions.push('Plaintext password detected — call PUT /iot/devices to re-save and encrypt.');
    }

    const profile = scoreDevice(device);
    for (const rec of profile.recommendations) {
      if (!actions.includes(rec)) actions.push(rec);
    }

    logSecurityEvent({
      type:     'remediation',
      severity: 'low',
      deviceId: id,
      message:  `Remediation initiated for "${device.name}": ${actions.length} action(s)`,
      details:  { actions },
    });

    return reply(200, {
      deviceId: id,
      actions,
      currentScore: profile.riskScore,
      riskLevel:    profile.riskLevel,
    });
  }

  return false;
};
